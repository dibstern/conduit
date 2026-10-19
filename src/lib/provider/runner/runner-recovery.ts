import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import { ClaudeEventPersistEffectTag } from "../../persistence/effect/claude-event-persist-effect.js";
import { requeueFailedSteers } from "../../persistence/effect/input-requeue-effect.js";
import { makeProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import type { TurnResult } from "../types.js";
import { runnerSinkId } from "./runner-protocol.js";
import type { SessionFailure, SessionTurn } from "./session-runner.js";

export const runningRunnerCommands = (
	sql: SqlClient.SqlClient,
	driverKind: string,
	driverForAccount: (accountId: string) => string | undefined,
	sessionId?: string,
) =>
	Effect.gen(function* () {
		const { projectId } = yield* PersistenceProjectTag;
		const rows = yield* sql<{
			project_key: string;
			session_id: string;
			provider_id: string;
			command_id: string;
			payload_json: string;
			user_message_id: string | null;
			attempt_count: number;
			assistant_message_id: string | null;
			state: string | null;
		}>`SELECT outbox.project_key, outbox.session_id, outbox.provider_id, outbox.command_id, outbox.payload_json,
		COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId')) AS user_message_id,
		outbox.attempt_count, turns.assistant_message_id, turns.state
		FROM provider_command_outbox outbox
		LEFT JOIN turns ON turns.session_id = outbox.session_id
			AND turns.user_message_id = COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId'))
		WHERE outbox.project_key = ${projectId}
			AND outbox.status = 'running' AND outbox.effect_type = 'send_turn'
			AND (${sessionId ?? null} IS NULL OR outbox.session_id = ${sessionId ?? null})
		ORDER BY outbox.request_sequence`;
		return rows.filter(
			(row) => driverForAccount(row.provider_id) === driverKind,
		);
	});

type RunningCommand = Effect.Success<
	ReturnType<typeof runningRunnerCommands>
>[number];

/** Reattach admitted commands to their payload without serializing live steers. */
export const recoverRunnerCommands = <T extends SessionTurn, E = never>(
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
		readonly onCompleted?: (
			row: RunningCommand,
			input: T,
			result: TurnResult,
		) => Effect.Effect<unknown, E>;
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
		const { projectId } = yield* PersistenceProjectTag;
		const rows = yield* runningRunnerCommands(
			sql,
			driverKind,
			options.driverForAccount,
			sessionId,
		);
		return rows.map((row) => {
			const input = options.decodeInput(row);
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
				terminal:
					row.state !== null &&
					row.state !== "pending" &&
					row.state !== "running",
				wait: Effect.gen(function* () {
					const execution = yield* Effect.result(options.replay(row, input));
					if (options.closing()) return;
					if (execution._tag === "Failure") {
						yield* options.failTurn(sinkId, execution.failure);
						return yield* settleRunnerCommand(
							sql,
							projectId,
							sessionId,
							row.command_id,
							row.attempt_count,
							undefined,
							execution.failure,
						);
					}
					const result = execution.success;
					if (result?.status === "completed" && options.onCompleted)
						yield* options.onCompleted(row, input, result);
					yield* settleRunnerCommand(
						sql,
						projectId,
						sessionId,
						row.command_id,
						row.attempt_count,
						result,
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
			userMessageId?: string;
			messageId: string;
			terminal: boolean;
		},
		failure: SessionFailure,
	) => Effect.Effect<void, E>,
) =>
	Effect.gen(function* () {
		const { projectId } = yield* PersistenceProjectTag;
		for (const row of yield* runningRunnerCommands(
			sql,
			driverKind,
			driverForAccount,
		)) {
			if (claimedSessions.has(row.session_id)) continue;
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
					...(row.user_message_id
						? { userMessageId: row.user_message_id }
						: {}),
					messageId: row.assistant_message_id ?? "",
					terminal:
						row.state !== null &&
						row.state !== "pending" &&
						row.state !== "running",
				},
				failure,
			);
			yield* settleRunnerCommand(
				sql,
				projectId,
				row.session_id,
				row.command_id,
				row.attempt_count,
				undefined,
				failure,
			);
		}
	});

/** Only durable writes: safe inside ingestion's CommitAndSignal transaction. */
export const settleRunnerCommandState = (
	sql: SqlClient.SqlClient,
	projectId: string,
	sessionId: string,
	commandId: string,
	attempt: number,
	result?: TurnResult,
	failure?: SessionFailure,
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{
			project_key: string;
			attempt_count: number;
		}>`SELECT project_key, attempt_count FROM provider_command_outbox WHERE project_key = ${projectId} AND command_id = ${commandId} AND session_id = ${sessionId} AND status = 'running' AND attempt_count = ${attempt}`;
		const row = rows[0];
		if (!row) return;
		const succeeded = !failure && result?.status === "completed";
		const retryable =
			result?.status !== "steer-declined" &&
			(failure?.retryable === true ||
				(result?.error?.retryable === true &&
					result.error.retryHandled !== true));
		const errorCode = succeeded
			? null
			: result?.status === "steer-declined"
				? result.status
				: String(
						failure?.code ??
							result?.error?.code ??
							result?.status ??
							"provider_failure",
					);
		const now = Date.now();
		const retryAt = retryable
			? now + Math.min(1000 * 2 ** row.attempt_count, 30_000)
			: null;
		if (succeeded && result?.providerStateUpdates.length) {
			const providerState = yield* makeProviderStateEffect.pipe(
				Effect.provideService(SqlClient.SqlClient, sql),
				Effect.provideService(PersistenceProjectTag, {
					projectId,
				}),
			);
			yield* providerState.saveUpdates(
				sessionId,
				result.providerStateUpdates.map(({ key, value }) => ({
					key,
					value: String(value),
				})),
			);
		}
		yield* sql`UPDATE provider_command_outbox SET status = ${succeeded ? "completed" : retryable ? "retryable_failed" : "failed"}, error_code = ${errorCode}, next_attempt_at = ${retryAt}, updated_at = ${now} WHERE project_key = ${projectId} AND command_id = ${commandId} AND session_id = ${sessionId} AND status = 'running' AND attempt_count = ${attempt}`;
		yield* sql`UPDATE command_receipts SET status = ${succeeded ? "side_effect_completed" : "side_effect_failed"}, error_code = ${errorCode}, updated_at = ${now} WHERE project_key = ${projectId} AND command_id = ${commandId}`;
	});

export const settleRunnerCommand = (
	sql: SqlClient.SqlClient,
	projectId: string,
	sessionId: string,
	commandId: string,
	attempt: number,
	result?: TurnResult,
	failure?: SessionFailure,
) =>
	sql
		.withTransaction(
			settleRunnerCommandState(
				sql,
				projectId,
				sessionId,
				commandId,
				attempt,
				result,
				failure,
			),
		)
		.pipe(
			Effect.tap(() =>
				Effect.gen(function* () {
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
				}),
			),
		);
