import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import {
	ClaudeEventPersistEffectTag,
	makeClaudeEventPersistEffect,
} from "../../persistence/effect/claude-event-persist-effect.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../persistence/effect/event-store-effect.js";
import { requeueFailedSteers } from "../../persistence/effect/input-requeue-effect.js";
import { ProjectionRunnerEffectTag } from "../../persistence/effect/projection-runner-effect.js";
import { runTerminalStatus } from "../../persistence/effect/projectors-effect.js";
import { makeProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import type { TurnResult } from "../types.js";
import { runnerSinkId } from "./runner-protocol.js";
import type { RunnerRecoveryDependencies } from "./runner-provider-instance.js";
import type { SessionFailure, SessionTurn } from "./session-runner.js";

export const runningRunnerCommands = (
	sql: SqlClient.SqlClient,
	driverKind: string,
	driverForAccount: (accountId: string) => string | undefined,
	sessionId?: string,
) =>
	Effect.gen(function* () {
		const project = yield* Effect.serviceOption(PersistenceProjectTag);
		const projectId = project._tag === "Some" ? project.value.projectId : null;
		const scope =
			sessionId === undefined
				? sql`(${projectId} IS NULL OR outbox.project_key = ${projectId})`
				: sql`outbox.session_id = ${sessionId} AND outbox.project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId})`;
		const rows = yield* sql<{
			project_key: string;
			session_id: string;
			provider_id: string;
			command_id: string;
			payload_json: string;
			run_id: string | null;
			error_code: string | null;
			user_message_id: string | null;
			attempt_count: number;
			assistant_message_id: string | null;
		}>`SELECT outbox.project_key, outbox.session_id, outbox.provider_id, outbox.command_id, outbox.payload_json,
		COALESCE(run.joined_into, run.id) AS run_id,
		COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId')) AS user_message_id,
		outbox.error_code, outbox.attempt_count, turns.assistant_message_id
		FROM provider_command_outbox outbox
		LEFT JOIN provider_runs run ON run.id = outbox.run_id AND run.session_id = outbox.session_id
		LEFT JOIN turns ON turns.session_id = outbox.session_id
			AND turns.user_message_id = COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId'))
		WHERE ${scope}
			AND outbox.status = 'running' AND outbox.effect_type = 'send_turn'
		ORDER BY outbox.request_sequence`;
		return rows.filter(
			(row) => driverForAccount(row.provider_id) === driverKind,
		);
	});

type RunningCommand = Effect.Success<
	ReturnType<typeof runningRunnerCommands>
>[number];

/** Reattach admitted commands to their payload without serializing live steers. */
export const recoverRunnerCommands = <T extends SessionTurn>(
	sql: SqlClient.SqlClient,
	sessionId: string,
	driverKind: string,
	options: {
		readonly driverForAccount: (accountId: string) => string | undefined;
		readonly decodeInput: (row: RunningCommand) => T;
		readonly replay: (
			row: RunningCommand,
			input: T,
		) => Effect.Effect<TurnResult | undefined, SessionFailure>;
		readonly resolveSinkId: (
			commandId: string,
			inputId: string,
			attempt: number,
			nativeResumeFallback?: boolean,
		) => string;
		readonly closing: () => boolean;
		readonly failTurn: (
			sinkId: string,
			failure: SessionFailure,
		) => Effect.Effect<void>;
	},
) =>
	Effect.gen(function* () {
		const rows = yield* runningRunnerCommands(
			sql,
			driverKind,
			options.driverForAccount,
			sessionId,
		);
		return rows.map((row) => {
			const input: T = {
				...options.decodeInput(row),
				runId: row.run_id ?? undefined,
			};
			const sinkId = options.resolveSinkId(
				row.command_id,
				input.inputId,
				row.attempt_count,
				input.nativeResumeFallback,
			);
			return {
				sinkId,
				input,
				messageId: row.assistant_message_id ?? "",
				...(row.run_id ? { runId: row.run_id } : {}),
				wait: Effect.gen(function* () {
					// The connection restores retained sinks and native output independently.
					// An unknown delivery must never become a second send after restart.
					if (row.error_code === "delivery_indeterminate") return;
					const execution = yield* Effect.result(options.replay(row, input));
					if (options.closing()) return;
					if (execution._tag === "Failure") {
						yield* options.failTurn(sinkId, execution.failure);
						return yield* settleRunnerCommand(
							sql,
							row.project_key,
							sessionId,
							row.command_id,
							row.attempt_count,
							undefined,
							execution.failure,
							driverKind,
						);
					}
					const result = execution.success;
					yield* settleRunnerCommand(
						sql,
						row.project_key,
						sessionId,
						row.command_id,
						row.attempt_count,
						result,
						undefined,
						driverKind,
					);
				}),
			};
		});
	});

/** A live runner, including a candidate or retiree, owns its session's admissions. */
export const settleUnclaimedRunnerCommands = <E>(
	sql: SqlClient.SqlClient,
	claimedSessions: ReadonlySet<string>,
	driverKind: string,
	driverForAccount: (accountId: string) => string | undefined,
	failTurn: (
		sinkId: string,
		turn: {
			sessionId: string;
			runId?: string;
			userMessageId?: string;
			messageId: string;
		},
		failure: SessionFailure,
	) => Effect.Effect<void, E>,
	recoveryForSession?: (
		sessionId: string,
	) => Effect.Effect<RunnerRecoveryDependencies | undefined>,
	sessionIds?: ReadonlySet<string>,
) =>
	Effect.gen(function* () {
		for (const row of yield* runningRunnerCommands(
			sql,
			driverKind,
			driverForAccount,
		)) {
			if (sessionIds && !sessionIds.has(row.session_id)) continue;
			if (claimedSessions.has(row.session_id)) continue;
			const recovery = yield* recoveryForSession?.(row.session_id) ??
				Effect.succeed(undefined);
			if (recoveryForSession && !recovery) continue;
			const failure: SessionFailure = {
				operation: "recover stopped runner",
				message: `${driverKind.charAt(0).toUpperCase()}${driverKind.slice(1)} runner stopped before completing the turn`,
				code: "runner_stopped",
				retryable: false,
			};
			yield* failTurn(
				runnerSinkId(
					row.command_id,
					row.attempt_count,
					(JSON.parse(row.payload_json) as SessionTurn).nativeResumeFallback,
				),
				{
					sessionId: row.session_id,
					...(row.run_id ? { runId: row.run_id } : {}),
					...(row.user_message_id
						? { userMessageId: row.user_message_id }
						: {}),
					messageId: row.assistant_message_id ?? "",
				},
				failure,
			);
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
		yield* sql.withTransaction(saveState);
	}).pipe(
		Effect.tap(() =>
			Effect.gen(function* () {
				const projector = yield* Effect.serviceOption(
					ProjectionRunnerEffectTag,
				);
				if (projector._tag === "None") {
					const persist = yield* Effect.serviceOption(
						ClaudeEventPersistEffectTag,
					);
					if (persist._tag === "Some")
						yield* requeueFailedSteers(
							sql,
							persist.value,
							sessionId,
							commandId,
						);
					return;
				}
				const eventStore = yield* makeEventStoreEffect.pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.provideService(PersistenceProjectTag, { projectId }),
				);
				const persist = yield* makeClaudeEventPersistEffect.pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.provideService(EventStoreEffectTag, eventStore),
					Effect.provideService(ProjectionRunnerEffectTag, projector.value),
				);
				yield* requeueFailedSteers(sql, persist, sessionId, commandId);
			}),
		),
	);
