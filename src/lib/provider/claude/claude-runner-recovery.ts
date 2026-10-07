import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../../daemon/config-persistence.js";
import {
	makeProviderStateEffect,
	ProviderStateEffectTag,
} from "../../persistence/effect/provider-state-effect.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../../persistence/effect/read-query-effect.js";
import type { ProviderNativeSession, TurnResult } from "../types.js";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import {
	type ClaudeRunnerSocket,
	claudeRunnerFailure,
	claudeRunnerSinkId,
} from "./claude-runner-protocol.js";
import type {
	ClaudeSessionFailure,
	ClaudeSessionTurn,
} from "./claude-session-runner.js";
import { makePrepareTurn } from "./prepare-turn.js";

const runningClaudeCommands = (sql: SqlClient.SqlClient, sessionId?: string) =>
	sql<{
		session_id: string;
		provider_id: string;
		command_id: string;
		payload_json: string;
		user_message_id: string | null;
		attempt_count: number;
		assistant_message_id: string | null;
		state: string | null;
	}>`SELECT outbox.session_id, outbox.provider_id, outbox.command_id, outbox.payload_json,
		json_extract(outbox.payload_json, '$.userMessageId') AS user_message_id,
		outbox.attempt_count, turns.assistant_message_id, turns.state
		FROM provider_command_outbox outbox
		LEFT JOIN turns ON turns.session_id = outbox.session_id
			AND turns.user_message_id = json_extract(outbox.payload_json, '$.userMessageId')
		WHERE outbox.status = 'running' AND outbox.effect_type = 'send_turn'
			AND (${sessionId ?? null} IS NULL OR outbox.session_id = ${sessionId ?? null})
		ORDER BY outbox.request_sequence`;

/** Reattach the outbox waiter to its original command, never start a second turn. */
export const recoverClaudeRunnerCommands = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	connection: ClaudeRunnerSocket,
	failTurn: (
		sinkId: string,
		failure: ClaudeSessionFailure,
	) => Effect.Effect<void>,
	closing: () => boolean,
	deps: ClaudeSessionRunnerDeps,
	liveSession: Effect.Effect<
		ProviderNativeSession | undefined
	> = Effect.succeed(undefined),
) =>
	Effect.gen(function* () {
		const config = loadDaemonConfig(deps.daemonConfigDir);
		const rows = yield* runningClaudeCommands(sql, sessionId);
		return rows
			.filter(
				(row) =>
					resolveProviderRoutingDriver(config, row.provider_id) === "claude",
			)
			.map((row) => {
				const sinkId = claudeRunnerSinkId(row.command_id, row.attempt_count);
				const input = {
					...(JSON.parse(row.payload_json) as ClaudeSessionTurn),
					commandId: row.command_id,
					commandAttempt: row.attempt_count,
				};
				const instanceId = input.instanceId ?? row.provider_id;
				return {
					sinkId,
					input,
					messageId: row.assistant_message_id ?? "",
					terminal:
						row.state !== null &&
						row.state !== "pending" &&
						row.state !== "running",
					wait: Effect.gen(function* () {
						const execution = yield* Effect.either(
							Effect.gen(function* () {
								const state = yield* makeProviderStateEffect;
								const read = yield* makeReadQueryEffect;
								const prepareTurn = yield* makePrepareTurn({
									liveSession: yield* liveSession,
									configDir: input.configDir,
									agent: input.agent,
									userMessageId: input.userMessageId,
									continuation: input.continuation,
									modelContextWindow:
										input.contextWindow === "1m" ? 1000000 : undefined,
								}).pipe(
									Effect.provideService(ProviderStateEffectTag, state),
									Effect.provideService(ReadQueryEffectTag, read),
								);
								const prepared = yield* prepareTurn(
									sessionId,
									instanceId,
									input.prompt,
								);
								return yield* connection.commandEffect(
									row.command_id,
									{
										type: "send-turn",
										sinkId,
										aborted: false,
										shellEnv: deps.shellEnv?.(input.workspaceRoot) ?? {
											...process.env,
										},
										claudeSettingsOverrides: deps.claudeSettingsOverrides?.(),
										input: {
											...input,
											instanceId,
											prompt: prepared.prompt,
											configDir: prepared.configDir,
											resumeSessionId: prepared.resumeSessionId,
											startFreshNativeSession:
												prepared.resumeSessionId === undefined,
											nativeThread: prepared.nativeThread,
											...(prepared.handoff
												? { handoff: prepared.handoff }
												: {}),
										},
									},
									row.attempt_count,
								);
							}).pipe(
								Effect.provideService(SqlClient.SqlClient, sql),
								Effect.mapError((cause) =>
									claudeRunnerFailure("recover turn", cause),
								),
							),
						);
						if (closing()) return;
						if (execution._tag === "Left") {
							yield* failTurn(sinkId, execution.left);
							return yield* settleClaudeRunnerCommand(
								sql,
								sessionId,
								row.command_id,
								row.attempt_count,
								undefined,
								execution.left,
							);
						}
						const result = execution.right;
						if (
							result?.status === "completed" &&
							result.handoff &&
							deps.persistHandoffDelivered
						) {
							yield* deps.persistHandoffDelivered(
								sessionId,
								result.handoff,
								row.command_id,
							);
						}
						yield* settleClaudeRunnerCommand(
							sql,
							sessionId,
							row.command_id,
							row.attempt_count,
							result,
						);
					}),
				};
			});
	});

/** Live sessions have already reattached their admitted commands during adoption. */
export const settleUnclaimedClaudeRunnerCommands = <E>(
	sql: SqlClient.SqlClient,
	claimedSessions: ReadonlySet<string>,
	failTurn: (
		sinkId: string,
		turn: {
			sessionId: string;
			userMessageId?: string;
			messageId: string;
			terminal: boolean;
		},
		failure: ClaudeSessionFailure,
	) => Effect.Effect<void, E>,
	daemonConfigDir?: string,
) =>
	Effect.gen(function* () {
		const config = loadDaemonConfig(daemonConfigDir);
		for (const row of yield* runningClaudeCommands(sql)) {
			if (resolveProviderRoutingDriver(config, row.provider_id) !== "claude")
				continue;
			// Candidates and retiring runners also own their session's admissions.
			if (claimedSessions.has(row.session_id)) continue;
			const failure: ClaudeSessionFailure = {
				operation: "recover stopped runner",
				message: "Claude runner stopped before completing the turn",
				code: "runner_stopped",
				retryable: false,
			};
			yield* failTurn(
				claudeRunnerSinkId(row.command_id, row.attempt_count),
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
			yield* settleClaudeRunnerCommand(
				sql,
				row.session_id,
				row.command_id,
				row.attempt_count,
				undefined,
				failure,
			);
		}
	});

const settleClaudeRunnerCommand = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	commandId: string,
	attempt: number,
	result?: TurnResult,
	failure?: ClaudeSessionFailure,
) =>
	sql
		.withTransaction(
			Effect.gen(function* () {
				const rows = yield* sql<{
					attempt_count: number;
				}>`SELECT attempt_count FROM provider_command_outbox WHERE command_id = ${commandId} AND session_id = ${sessionId} AND status = 'running' AND attempt_count = ${attempt}`;
				const row = rows[0];
				if (!row) return;
				const succeeded = !failure && result?.status === "completed";
				const retryable =
					failure?.retryable === true || result?.error?.retryable === true;
				const errorCode = succeeded
					? null
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
					);
					yield* providerState.saveUpdates(
						sessionId,
						result.providerStateUpdates.map(({ key, value }) => ({
							key,
							value: String(value),
						})),
					);
				}
				yield* sql`UPDATE provider_command_outbox SET status = ${succeeded ? "completed" : retryable ? "retryable_failed" : "failed"}, error_code = ${errorCode}, next_attempt_at = ${retryAt}, updated_at = ${now} WHERE command_id = ${commandId} AND session_id = ${sessionId} AND status = 'running' AND attempt_count = ${attempt}`;
				yield* sql`UPDATE command_receipts SET status = ${succeeded ? "side_effect_completed" : "side_effect_failed"}, error_code = ${errorCode}, updated_at = ${now} WHERE command_id = ${commandId}`;
			}),
		)
		.pipe(Effect.asVoid);
