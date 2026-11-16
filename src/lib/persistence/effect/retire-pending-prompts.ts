import { Context, Effect, Exit, Option, Scope } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { OwnerScopes } from "../../domain/daemon/Services/owner-scopes.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import { PendingInteractionServiceTag } from "../../domain/project-services/Services/pending-interaction-service.js";
import { type CanonicalEvent, canonicalEvent } from "../events.js";
import { makeCommitAndSignal } from "./commit-and-signal.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "./event-store-effect.js";
import { ProjectionRunnerEffectTag } from "./projection-runner-effect.js";
import {
	ENDED_ROW_COLUMNS,
	type EndedOutboxRow,
	endedRowOutcome,
} from "./run-ledger-arm.js";

interface PendingPrompt {
	readonly id: string;
	readonly sessionId: string;
	readonly type: "permission" | "question";
}

/**
 * Expiration is a durable resolution, just like an answer. cancelControls returns the outcomes of
 * the controls it ends, appended in this write (3.12).
 */
export const retirePendingPrompts = (
	prompts: readonly PendingPrompt[],
	cancelControls: Effect.Effect<
		readonly CanonicalEvent[],
		SqlError
	> = Effect.succeed([]),
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const eventStore = yield* EventStoreEffectTag;
		const commit = yield* makeCommitAndSignal;
		const pending = yield* Effect.serviceOption(PendingInteractionServiceTag);
		const retired = yield* commit.write((project) =>
			Effect.gen(function* () {
				const outcomes = yield* cancelControls;
				const remaining: PendingPrompt[] = [];
				for (const prompt of prompts) {
					const rows = yield* sql`SELECT pa.id FROM pending_approvals pa
						JOIN sessions s ON s.id = pa.session_id
						WHERE pa.id = ${prompt.id} AND pa.session_id = ${prompt.sessionId}
							AND pa.type = ${prompt.type} AND pa.status = 'pending'
							AND COALESCE(json_extract(pa.details, '$.delivery'), '') <> 'async'
							AND s.project_id = ${eventStore.projectId}`;
					if (rows.length > 0) remaining.push(prompt);
				}
				const events = remaining.map(
					(prompt): CanonicalEvent =>
						prompt.type === "permission"
							? canonicalEvent(
									"permission.resolved",
									prompt.sessionId,
									{ id: prompt.id, decision: "reject" },
									{ metadata: { source: "provider-process-expired" } },
								)
							: canonicalEvent(
									"question.resolved",
									prompt.sessionId,
									{ id: prompt.id, answers: {} },
									{ metadata: { source: "provider-process-expired" } },
								),
				);
				if (outcomes.length + events.length > 0)
					yield* project(
						yield* eventStore.appendBatch([...outcomes, ...events]),
					);
				return remaining;
			}),
		);
		if (Option.isSome(pending)) {
			for (const sessionId of new Set(
				retired.map((prompt) => prompt.sessionId),
			))
				yield* pending.value.cancelSessionInteractions(
					sessionId,
					"The provider process that asked this prompt was replaced",
					{
						requestIds: new Set(
							retired
								.filter((prompt) => prompt.sessionId === sessionId)
								.map((prompt) => prompt.id),
						),
					},
				);
		}
		return retired.length;
	});

/**
 * 82tn.14: a removed project's open asks resolve with its owner scope, as a retired runner's do
 * (CONTRACT.md 3.11 has no rule for them; nearest reading: its runners retire at removal). A detach
 * keeps them for the next daemon; the binding of a replaced relay (`relayScope` closed) does nothing.
 */
export const retireAsksOnProjectRemoval = (relayScope: Scope.Scope) =>
	Effect.gen(function* () {
		const owners = yield* Effect.serviceOption(OwnerScopes);
		if (Option.isNone(owners)) return;
		const { projectId } = yield* EventStoreEffectTag;
		let live = true;
		yield* Scope.addFinalizer(
			relayScope,
			Effect.sync(() => (live = false)),
		);
		const context = yield* Effect.context<
			SqlClient.SqlClient | EventStoreEffectTag | ProjectionRunnerEffectTag
		>();
		const pending = yield* Effect.serviceOption(PendingInteractionServiceTag);
		const retire = Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* retirePendingPrompts(
				yield* sql<PendingPrompt>`SELECT pa.id, pa.session_id AS sessionId, pa.type
					FROM pending_approvals pa JOIN sessions s ON s.id = pa.session_id
					WHERE s.project_id = ${projectId} AND pa.status = 'pending'
						AND pa.type IN ('permission', 'question')`,
			);
		}).pipe(
			Option.isSome(pending)
				? Effect.provideService(PendingInteractionServiceTag, pending.value)
				: (effect) => effect,
			Effect.provide(context),
			Effect.catchCause((cause) =>
				Effect.logWarning(
					"Could not resolve a removed project's open asks",
					cause,
				),
			),
		);
		yield* owners.value.projectScope(projectId).pipe(
			Effect.flatMap((scope) =>
				scope.acquire<void, never, never>(
					Effect.addFinalizer((exit) =>
						live && Exit.isSuccess(exit) && exit.value === "remove"
							? retire
							: Effect.void,
					),
				),
			),
			Effect.ignore,
		);
	});

/** Non-persistent runner and stream test stacks have no prompts to retire. */
export const makeRetireReplacedProcessPrompts = Effect.gen(function* () {
	const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
	const eventStore = yield* Effect.serviceOption(EventStoreEffectTag);
	const projector = yield* Effect.serviceOption(ProjectionRunnerEffectTag);
	type Scope =
		| {
				readonly sessionId: string;
				readonly expiredProcessId?: string;
				readonly exceptCommandId?: string;
		  }
		| { readonly providerInstanceIds: readonly string[] };
	if (
		Option.isNone(sql) ||
		Option.isNone(eventStore) ||
		Option.isNone(projector)
	)
		return (_currentProcessId: string | null, _scope: Scope) =>
			Effect.succeed(0);
	const context = (yield* Effect.context<never>()).pipe(
		Context.omit(PendingInteractionServiceTag),
		Context.add(SqlClient.SqlClient, sql.value),
		Context.add(EventStoreEffectTag, eventStore.value),
		Context.add(ProjectionRunnerEffectTag, projector.value),
	);
	return (currentProcessId: string | null, scope: Scope) =>
		Effect.gen(function* () {
			const client = sql.value;
			const projectId =
				"sessionId" in scope
					? (yield* client<{
							project_id: string;
						}>`SELECT project_id FROM sessions WHERE id = ${scope.sessionId}`)[0]
							?.project_id
					: eventStore.value.projectId;
			if (projectId === undefined) return 0;
			const store =
				projectId === eventStore.value.projectId
					? eventStore.value
					: yield* makeEventStoreEffect.pipe(
							Effect.provideService(PersistenceProjectTag, { projectId }),
						);
			const rows = yield* client<{
				id: string;
				session_id: string;
				type: "permission" | "question";
			}>`SELECT pa.id, pa.session_id, pa.type FROM pending_approvals pa
				JOIN sessions s ON s.id = pa.session_id
				WHERE pa.status = 'pending'
					AND COALESCE(json_extract(pa.details, '$.delivery'), '') <> 'async'
					AND (${currentProcessId} IS NULL OR (pa.provider_process_id IS NOT NULL
						AND pa.provider_process_id <> ${currentProcessId}))
					AND s.project_id = ${projectId}
					AND ${"sessionId" in scope && scope.expiredProcessId ? client`pa.provider_process_id = ${scope.expiredProcessId}` : client`1 = 1`}
					AND ${"sessionId" in scope ? client`pa.session_id = ${scope.sessionId}` : client`s.provider IN ${client.in(scope.providerInstanceIds)}`}`;
			return yield* retirePendingPrompts(
				rows.map((row) => ({
					id: row.id,
					sessionId: row.session_id,
					type: row.type,
				})),
				Effect.gen(function* () {
					const now = Date.now();
					const cancelled = yield* client<
						EndedOutboxRow & { effect_type: string }
					>`UPDATE provider_command_outbox
						SET status = 'cancelled', payload_json = CASE WHEN json_valid(payload_json) THEN json_remove(payload_json, '$.images') ELSE payload_json END, error_code = 'provider_process_gone', next_attempt_at = NULL, updated_at = ${now}
						WHERE effect_type <> 'send_turn' AND status IN ('pending', 'running', 'retryable_failed')
							AND (${"sessionId" in scope ? (scope.exceptCommandId ?? null) : null} IS NULL
								OR command_id <> ${"sessionId" in scope ? (scope.exceptCommandId ?? null) : null})
							AND project_key = ${projectId}
							AND ${"sessionId" in scope && scope.expiredProcessId ? client`provider_process_id = ${scope.expiredProcessId}` : client`1 = 1`}
							AND (${currentProcessId} IS NULL OR (provider_process_id IS NOT NULL AND provider_process_id <> ${currentProcessId}))
							AND session_id IN (SELECT s.id FROM sessions s WHERE s.project_id = ${projectId}
								AND ${"sessionId" in scope ? client`s.id = ${scope.sessionId}` : client`s.provider IN ${client.in(scope.providerInstanceIds)}`})
						RETURNING effect_type, ${client.literal(ENDED_ROW_COLUMNS)}`;
					for (const command of cancelled)
						yield* client`UPDATE command_receipts SET status = 'side_effect_failed', error_code = 'provider_process_gone',
						error = ${JSON.stringify({ _tag: "ProviderInstanceFailure", providerId: command.provider_id, operation: command.effect_type, code: "provider_process_gone", causeMessage: "The target provider process is no longer available" })}, updated_at = ${now}
						WHERE project_key = ${projectId} AND command_id = ${command.command_id}`;
					return cancelled.map(endedRowOutcome);
				}),
			).pipe(Effect.provideService(EventStoreEffectTag, store));
		}).pipe(Effect.provide(context));
});
