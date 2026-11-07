import { Clock, Context, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import * as Failure from "../../effect/failure-classification.js";
import { ClaudeEventPersistEffectTag } from "../../persistence/effect/claude-event-persist-effect.js";
import {
	currentRunnerWriteOrigin,
	flushPendingWrites,
	makeUnboundCommitAndSignal,
} from "../../persistence/effect/commit-and-signal.js";
import {
	makeUnboundEventStoreEffect,
	UnboundEventStoreEffectTag,
} from "../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../persistence/effect/projection-runner-effect.js";
import { runTerminalStatus } from "../../persistence/effect/projectors-effect.js";
import { makeProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import { loadLedger } from "../../persistence/effect/run-ledger-arm.js";
import { isRecord } from "../../utils.js";
import {
	ClaudeConfigDirSchema,
	configuredClaudeConfigDir,
} from "../claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../errors.js";
import type { OrchestrationEngine } from "../orchestration-engine.js";
import { viewLedger } from "../run-ledger/run-ledger-decider.js";
import type { TurnResult } from "../types.js";
import { legacyRunnerRunQuery } from "./runner-legacy-classification.js";
import { runnerFailure, runnerSinkId } from "./runner-protocol.js";
import type { RunnerRecoveryDependencies } from "./runner-provider-instance.js";
import { retrySettlementWrite } from "./send-settlement.js";
import { requeueLegacySend, settleSend } from "./send-settlement-outbox.js";
import type { DurableSessionTurn, SessionFailure } from "./session-runner.js";

/** Same-daemon recovery keeps a row while its exact reactor attempt owns it. */
export const currentPendingSendOwner = Context.Reference<
	OrchestrationEngine["ownsPendingSend"] | undefined
>("conduit/provider/currentPendingSendOwner", {
	defaultValue: () => undefined,
});

/** Adoption checks durable completion before admitting a retained runner send. */
export const runnerCommandEnded = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	commandId: string,
	attempt?: number,
) =>
	sql<{
		status: string;
		attempt_count: number;
		run_state: string | null;
		run_id: string | null;
		turn_state: string | null;
	}>`
	SELECT outbox.status, outbox.attempt_count, owner.status AS run_state, outbox.run_id, turns.state AS turn_state
	FROM provider_command_outbox outbox
	LEFT JOIN provider_runs reservation ON reservation.id = outbox.run_id AND reservation.session_id = outbox.session_id
	LEFT JOIN provider_runs owner ON owner.id = COALESCE(reservation.joined_into, reservation.id) AND owner.session_id = outbox.session_id
	LEFT JOIN turns ON turns.session_id = outbox.session_id
		AND turns.user_message_id = COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId'))
	WHERE outbox.project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId})
		AND outbox.session_id = ${sessionId} AND outbox.command_id = ${commandId}
	ORDER BY outbox.request_sequence DESC LIMIT 1`.pipe(
		Effect.map(([row]) =>
			row
				? (attempt !== undefined && row.attempt_count !== attempt) ||
					(row.status !== "running" && row.status !== "completed") ||
					// Modern commands acknowledge intake before the send ends. Their
					// resolved run owns completion, not an older retry/continuation turn.
					(row.run_state !== null
						? row.run_state !== "pending" && row.run_state !== "running"
						: row.status !== "running" ||
							(row.run_id === null &&
								row.turn_state !== null &&
								row.turn_state !== "pending" &&
								row.turn_state !== "running"))
				: attempt !== undefined,
		),
		Effect.mapError((cause) => runnerFailure("check recovered command", cause)),
	);

export const runningRunnerCommands = (
	sql: SqlClient.SqlClient,
	driverKind: string,
	driverForAccount: (accountId: string) => string | undefined,
	sessionId?: string,
	ownerSend?: { readonly runId: string; readonly commandId: string },
	includeHeld = false,
) =>
	Effect.gen(function* () {
		const project = yield* Effect.serviceOption(PersistenceProjectTag);
		const projectId = project._tag === "Some" ? project.value.projectId : null;
		const scope =
			sessionId === undefined
				? sql`(${projectId} IS NULL OR outbox.project_key = ${projectId})`
				: sql`outbox.session_id = ${sessionId} AND outbox.project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId})`;
		const owner = ownerSend
			? // From 32.5 a joined steer's send is its own run's (CONTRACT 2021-2025).
				sql`outbox.command_id = ${ownerSend.commandId} AND outbox.run_id = ${ownerSend.runId}`
			: sql`1`;
		const rows = yield* sql<{
			request_sequence: number;
			project_key: string;
			session_id: string;
			provider_id: string;
			command_id: string;
			payload_json: string;
			run_id: string | null;
			error_code: string | null;
			status: string;
			user_message_id: string | null;
			attempt_count: number;
			assistant_message_id: string | null;
			held_transmission: number | null;
		}>`SELECT outbox.request_sequence, outbox.project_key, outbox.session_id, outbox.provider_id, outbox.command_id, outbox.payload_json,
		COALESCE(run.joined_into, run.id) AS run_id, run.held_transmission,
		COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId')) AS user_message_id,
		outbox.error_code, outbox.status, outbox.attempt_count, turns.assistant_message_id
		FROM provider_command_outbox outbox
		LEFT JOIN provider_runs run ON run.id = outbox.run_id AND run.session_id = outbox.session_id
		LEFT JOIN turns ON turns.session_id = outbox.session_id
			AND turns.user_message_id = COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId'))
		WHERE ${scope} AND ${owner}
			AND (outbox.status = 'running' OR (${includeHeld ? 1 : 0}
				AND run.status IN ('pending', 'running') AND run.runner_id IS NOT NULL
				AND run.held_transmission IS NOT NULL))
			AND outbox.effect_type = 'send_turn'
		ORDER BY outbox.request_sequence`;
		const commands = rows.filter(
			(row) => driverForAccount(row.provider_id) === driverKind,
		);
		if (driverKind === "claude")
			for (const row of commands) {
				const payload = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
				)(row.payload_json).pipe(
					Effect.mapError(
						(cause) =>
							new ProviderInstanceFailure({
								providerId: "claude",
								operation: "validate stored folders",
								cause,
							}),
					),
				);
				const nativeThread = payload["nativeThread"];
				for (const folder of [
					payload["configDir"],
					...(isRecord(nativeThread) ? [nativeThread["configDir"]] : []),
				])
					if (folder !== undefined)
						yield* Schema.decodeUnknownEffect(ClaudeConfigDirSchema)(
							typeof folder === "string"
								? configuredClaudeConfigDir(folder)
								: folder,
						).pipe(
							Effect.mapError(
								(cause) =>
									new ProviderInstanceFailure({
										providerId: "claude",
										operation: "validate stored folders",
										cause,
									}),
							),
						);
			}
		return commands;
	});

/** Attached runners claim admissions; live retirement cleanup owns its captured runs. */
export const settleUnclaimedRunnerCommands = <E>(
	sql: SqlClient.SqlClient,
	claimedSessions: ReadonlySet<string>,
	driverKind: string,
	driverForAccount: (accountId: string) => string | undefined,
	failTurn: (
		sinkId: string,
		turn: {
			sessionId: string;
			accountId: string;
			runId?: string;
			userMessageId?: string;
			messageId: string;
		},
		failure: SessionFailure,
		beforeProject: Effect.Effect<void, SqlError>,
	) => Effect.Effect<void, E>,
	recoveryForSession?: (
		sessionId: string,
	) => Effect.Effect<RunnerRecoveryDependencies | undefined>,
	sessionIds?: ReadonlySet<string>,
	ownsPendingSend?: OrchestrationEngine["ownsPendingSend"],
	ownsRetirementCleanup?: (
		sessionId: string,
		runId: string,
	) => Effect.Effect<boolean, SqlError>,
) =>
	Effect.gen(function* () {
		for (const row of yield* runningRunnerCommands(
			sql,
			driverKind,
			driverForAccount,
		)) {
			if (sessionIds && !sessionIds.has(row.session_id)) continue;
			if (claimedSessions.has(row.session_id)) continue;
			const unclaimed = Effect.suspend(() =>
				row.run_id && ownsRetirementCleanup
					? ownsRetirementCleanup(row.session_id, row.run_id).pipe(
							Effect.flatMap((owned) =>
								owned ? Effect.interrupt : Effect.void,
							),
						)
					: Effect.void,
			);
			if (
				row.run_id &&
				ownsRetirementCleanup &&
				(yield* ownsRetirementCleanup(row.session_id, row.run_id))
			)
				continue;
			const recovery = yield* recoveryForSession?.(row.session_id) ??
				Effect.succeed(undefined);
			if (recoveryForSession && !recovery) continue;
			const failure: SessionFailure = {
				operation: "recover stopped runner",
				message: `${driverKind.charAt(0).toUpperCase()}${driverKind.slice(1)} runner stopped before completing the turn`,
				code: "runner_stopped",
				retryable: false,
			};
			const [requested] = yield* sql<{
				joined_into: string | null;
			}>`SELECT run.joined_into
				FROM provider_command_outbox command JOIN provider_runs run
					ON run.id = command.run_id AND run.session_id = command.session_id
				WHERE command.request_sequence = ${row.request_sequence} AND command.project_key = ${row.project_key}`;
			if (
				row.run_id &&
				requested?.joined_into === null &&
				!(yield* legacyRunnerRunQuery(sql, row.session_id, row.run_id))
			) {
				const projector = yield* Effect.serviceOption(
					ProjectionRunnerEffectTag,
				);
				if (projector._tag === "None") continue;
				const eventStore = yield* makeUnboundEventStoreEffect.pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
				);
				const commit = yield* makeUnboundCommitAndSignal.pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.provideService(UnboundEventStoreEffectTag, eventStore),
					Effect.provideService(ProjectionRunnerEffectTag, projector.value),
				);
				const evidence = {
					_tag: "failed" as const,
					send: {
						sessionId: row.session_id,
						runId: row.run_id,
						commandId: row.command_id,
						requestSequence: row.request_sequence,
						attempt: row.attempt_count,
					},
					failure,
					observedAt: yield* Clock.currentTimeMillis,
				};
				const followUps: Effect.Effect<void>[] = [];
				yield* retrySettlementWrite(
					commit.write(
						(project, stamp) =>
							Effect.gen(function* () {
								followUps.length = 0;
								if (
									ownsPendingSend?.(
										row.session_id,
										row.command_id,
										row.request_sequence,
										row.attempt_count,
									)
								)
									return;
								if (
									ownsRetirementCleanup &&
									(yield* ownsRetirementCleanup(
										row.session_id,
										evidence.send.runId,
									))
								)
									return;
								if (
									yield* legacyRunnerRunQuery(
										sql,
										row.session_id,
										evidence.send.runId,
									)
								)
									return;
								// CONTRACT 667-672, 682-691 (D50): a send its Run's ledger holds Launched with no
								// evidence, never held, was not yet delivered; main returns it to the outbox to be
								// sent once under its commandId, appending no terminal. A steer that Run issued
								// stays its input (3.9) and goes back too, sent after its start (L2 case 2).
								const ledger = yield* loadLedger(row.session_id).pipe(
									Effect.provideService(SqlClient.SqlClient, sql),
								);
								const active = ledger && viewLedger(ledger.state).active;
								if (
									active?.tag === "Starting" &&
									(active.runId === evidence.send.runId ||
										active.inputs.some(
											({ inputId }) => inputId === row.user_message_id,
										)) &&
									(yield* sql`SELECT 1 FROM provider_runs
										WHERE id IN (${evidence.send.runId}, ${active.runId}) AND session_id = ${row.session_id}
											AND (runner_id IS NOT NULL OR held_transmission IS NOT NULL)`)
										.length === 0
								)
									return yield* requeueLegacySend(
										{ sql, project, stamp },
										row,
										evidence.observedAt,
									);
								yield* settleSend(
									{
										sql,
										project,
										stamp,
										driverKind,
										...(recovery
											? {
													persistUserMessage:
														recovery.persist.persistUserMessage,
												}
											: {}),
										...(recovery?.inputDrafts
											? { inputDrafts: recovery.inputDrafts }
											: {}),
										afterCommit: (effect) => followUps.push(effect),
									},
									evidence,
								);
							}),
						{
							projectId: row.project_key,
							afterCommit: Effect.suspend(() =>
								Effect.forEach(followUps, (effect) => effect, {
									discard: true,
								}),
							),
						},
					),
				);
				yield* recovery?.wakeReactor ?? Effect.void;
				continue;
			}
			const settled = yield* failTurn(
				runnerSinkId(
					row.command_id,
					row.attempt_count,
					(JSON.parse(row.payload_json) as DurableSessionTurn)
						.nativeResumeFallback,
				),
				{
					sessionId: row.session_id,
					accountId: row.provider_id,
					...(row.run_id ? { runId: row.run_id } : {}),
					...(row.user_message_id
						? { userMessageId: row.user_message_id }
						: {}),
					messageId: row.assistant_message_id ?? "",
				},
				failure,
				Effect.gen(function* () {
					yield* unclaimed;
					// Acquire the write lock and compare the snapshot in the same
					// ingestion transaction that would append the orphan terminal.
					const [current] =
						yield* sql`UPDATE provider_command_outbox SET status = status
						WHERE request_sequence = ${row.request_sequence}
							AND project_key = ${row.project_key} AND command_id = ${row.command_id}
							AND session_id = ${row.session_id} AND status = ${row.status}
							AND attempt_count = ${row.attempt_count} RETURNING command_id`;
					if (
						!current ||
						ownsPendingSend?.(
							row.session_id,
							row.command_id,
							row.request_sequence,
							row.attempt_count,
						)
					)
						return yield* Effect.interrupt;
				}),
			).pipe(
				Effect.as(true),
				Effect.catchCause((cause) =>
					Failure.isInterruptedOnly(cause)
						? Effect.succeed(false)
						: Effect.failCause(cause),
				),
			);
			if (!settled) continue;
			const settle = settleRunnerCommand(
				sql,
				row.project_key,
				row.session_id,
				row.command_id,
				row.attempt_count,
				undefined,
				failure,
				driverKind,
			);
			yield* recovery
				? settle.pipe(
						Effect.provideService(
							ClaudeEventPersistEffectTag,
							recovery.persist,
						),
					)
				: settle;
		}
	});

export const settleRunnerCommand = (
	sql: SqlClient.SqlClient,
	projectId: string,
	sessionId: string,
	commandId: string,
	attempt: number,
	result: TurnResult | undefined,
	failure: SessionFailure | undefined,
	driverKind: string,
	runnerId?: string,
) =>
	Effect.gen(function* () {
		const succeeded =
			!failure &&
			result !== undefined &&
			runTerminalStatus(
				{
					type: `turn.${result.status === "joined" ? "completed" : result.status}`,
					data: {},
				},
				driverKind,
			) === "completed";
		const saveState = Effect.gen(function* () {
			if (!succeeded || !result?.providerStateUpdates.length) return;
			const [current] = yield* sql`SELECT 1 FROM provider_command_outbox
				WHERE project_key = ${projectId} AND command_id = ${commandId}
					AND session_id = ${sessionId} AND attempt_count = ${attempt}`;
			if (!current) return;
			const providerState = yield* makeProviderStateEffect.pipe(
				Effect.provideService(SqlClient.SqlClient, sql),
				Effect.provideService(PersistenceProjectTag, { projectId }),
			);
			yield* providerState.saveUpdates(
				sessionId,
				result.providerStateUpdates.map(({ key, value }) => ({
					key,
					value: String(value),
				})),
			);
		});
		const origin = runnerId ?? (yield* currentRunnerWriteOrigin);
		const projector = yield* Effect.serviceOption(ProjectionRunnerEffectTag);
		// Minimal state-only runners have no projection capability. Their terminal
		// ingestion already owns any input reconciliation through the seam.
		if (projector._tag === "None")
			return yield* flushPendingWrites(
				sql,
				saveState,
				origin ? { runnerId: origin } : {},
			);
		const eventStore = yield* makeUnboundEventStoreEffect.pipe(
			Effect.provideService(SqlClient.SqlClient, sql),
		);
		const commit = yield* makeUnboundCommitAndSignal.pipe(
			Effect.provideService(SqlClient.SqlClient, sql),
			Effect.provideService(UnboundEventStoreEffectTag, eventStore),
			Effect.provideService(ProjectionRunnerEffectTag, projector.value),
		);
		yield* commit.write(() => saveState, {
			projectId,
			...(origin ? { runnerId: origin } : {}),
		});
	});
