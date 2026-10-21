import { Context, Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { PendingInteractionServiceTag } from "../../domain/relay/Services/pending-interaction-service.js";
import { canonicalEvent } from "../events.js";
import { makeCommitAndSignal } from "./commit-and-signal.js";
import { EventStoreEffectTag } from "./event-store-effect.js";
import { ProjectionRunnerEffectTag } from "./projection-runner-effect.js";

interface PendingPrompt {
	readonly id: string;
	readonly sessionId: string;
	readonly type: "permission" | "question";
}

/** Expiration is a durable resolution, just like an answer. */
export const retirePendingPrompts = (prompts: readonly PendingPrompt[]) =>
	Effect.gen(function* () {
		if (prompts.length === 0) return 0;
		const sql = yield* SqlClient.SqlClient;
		const eventStore = yield* EventStoreEffectTag;
		const commit = yield* makeCommitAndSignal;
		const pending = yield* Effect.serviceOption(PendingInteractionServiceTag);
		const retired = yield* commit.write((project) =>
			Effect.gen(function* () {
				const remaining: PendingPrompt[] = [];
				for (const prompt of prompts) {
					const rows = yield* sql`SELECT pa.id FROM pending_approvals pa
						JOIN sessions s ON s.id = pa.session_id
						WHERE pa.id = ${prompt.id} AND pa.session_id = ${prompt.sessionId}
							AND pa.type = ${prompt.type} AND pa.status = 'pending'
							AND s.project_id = ${eventStore.projectId}`;
					if (rows.length > 0) remaining.push(prompt);
				}
				if (remaining.length === 0) return remaining;
				const events = remaining.map((prompt) =>
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
				yield* project(yield* eventStore.appendBatch(events));
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

/** Non-persistent runner and stream test stacks have no prompts to retire. */
export const makeRetireReplacedProcessPrompts = Effect.gen(function* () {
	const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
	const eventStore = yield* Effect.serviceOption(EventStoreEffectTag);
	const projector = yield* Effect.serviceOption(ProjectionRunnerEffectTag);
	type Scope =
		| { readonly sessionId: string }
		| { readonly providerInstanceIds: readonly string[] };
	if (
		Option.isNone(sql) ||
		Option.isNone(eventStore) ||
		Option.isNone(projector)
	)
		return (_currentProcessId: string | null, _scope: Scope) =>
			Effect.succeed(0);
	const context = (yield* Effect.context<never>()).pipe(
		Context.add(SqlClient.SqlClient, sql.value),
		Context.add(EventStoreEffectTag, eventStore.value),
		Context.add(ProjectionRunnerEffectTag, projector.value),
	);
	return (currentProcessId: string | null, scope: Scope) =>
		Effect.gen(function* () {
			const client = sql.value;
			const rows = yield* client<{
				id: string;
				session_id: string;
				type: "permission" | "question";
			}>`SELECT pa.id, pa.session_id, pa.type FROM pending_approvals pa
				JOIN sessions s ON s.id = pa.session_id
				WHERE pa.status = 'pending'
					AND (${currentProcessId} IS NULL OR (pa.provider_process_id IS NOT NULL
						AND pa.provider_process_id <> ${currentProcessId}))
					AND s.project_id = ${eventStore.value.projectId}
					AND ${"sessionId" in scope ? client`pa.session_id = ${scope.sessionId}` : client`s.provider IN ${client.in(scope.providerInstanceIds)}`}`;
			return yield* retirePendingPrompts(
				rows.map((row) => ({
					id: row.id,
					sessionId: row.session_id,
					type: row.type,
				})),
			);
		}).pipe(Effect.provide(context));
});
