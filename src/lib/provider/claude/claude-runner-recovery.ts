import type { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import type { TurnResult } from "../types.js";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import {
	type ClaudeRunnerSocket,
	claudeRunnerSinkId,
	normalizeClaudeSessionTurn,
} from "./claude-runner-protocol.js";
import type {
	ClaudeSessionFailure,
	ClaudeSessionTurn,
} from "./claude-session-runner.js";

const runningClaudeCommands = (sql: SqlClient.SqlClient, sessionId?: string) =>
	sql<{
		session_id: string;
		command_id: string;
		payload_json: string;
		input_id: string | null;
		attempt_count: number;
		assistant_message_id: string | null;
		state: string | null;
	}>`SELECT outbox.session_id, outbox.command_id, outbox.payload_json,
		COALESCE(json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId')) AS input_id,
		outbox.attempt_count, turns.assistant_message_id, turns.state
		FROM provider_command_outbox outbox
		LEFT JOIN turns ON turns.session_id = outbox.session_id
			AND turns.user_message_id = COALESCE(json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId'))
		WHERE outbox.provider_id = 'claude' AND outbox.status = 'running' AND outbox.effect_type = 'send_turn'
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
	resolveSinkId?: (
		commandId: string,
		inputId: string,
		attempt: number,
	) => string,
) =>
	Effect.gen(function* () {
		const rows = yield* runningClaudeCommands(sql, sessionId);
		return rows.map((row) => {
			const input = {
				...normalizeClaudeSessionTurn(
					JSON.parse(row.payload_json) as ClaudeSessionTurn,
				),
				commandAttempt: row.attempt_count,
			};
			const sinkId =
				resolveSinkId?.(row.command_id, input.inputId, row.attempt_count) ??
				claudeRunnerSinkId(row.command_id, row.attempt_count);
			return {
				sinkId,
				input,
				messageId: row.assistant_message_id ?? "",
				terminal:
					row.state !== null &&
					row.state !== "pending" &&
					row.state !== "running",
				wait: connection
					.commandEffect(
						row.command_id,
						{
							type: "send-turn",
							sinkId,
							aborted: false,
							historyOnDemand: true,
							shellEnv: deps.shellEnv?.(input.workspaceRoot) ?? {
								...process.env,
							},
							claudeSettingsOverrides: deps.claudeSettingsOverrides?.(),
							input: { ...input, history: [] },
						},
						row.attempt_count,
					)
					.pipe(
						Effect.matchEffect({
							onSuccess: (result) =>
								closing()
									? Effect.void
									: settleClaudeRunnerCommand(
											sql,
											sessionId,
											row.command_id,
											row.attempt_count,
											result,
										),
							onFailure: (failure) =>
								closing()
									? Effect.void
									: failTurn(sinkId, failure).pipe(
											Effect.andThen(
												settleClaudeRunnerCommand(
													sql,
													sessionId,
													row.command_id,
													row.attempt_count,
													undefined,
													failure,
												),
											),
										),
						}),
					),
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
			inputId?: string;
			messageId: string;
			terminal: boolean;
		},
		failure: ClaudeSessionFailure,
	) => Effect.Effect<void, E>,
) =>
	Effect.gen(function* () {
		for (const row of yield* runningClaudeCommands(sql)) {
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
					...(row.input_id ? { inputId: row.input_id } : {}),
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
				for (const update of result?.providerStateUpdates ?? [])
					yield* sql`INSERT INTO provider_state (session_id, key, value) VALUES (${sessionId}, ${update.key}, ${String(update.value)}) ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value`;
				yield* sql`UPDATE provider_command_outbox SET status = ${succeeded ? "completed" : retryable ? "retryable_failed" : "failed"}, error_code = ${errorCode}, next_attempt_at = ${retryAt}, updated_at = ${now} WHERE command_id = ${commandId} AND session_id = ${sessionId} AND status = 'running' AND attempt_count = ${attempt}`;
				yield* sql`UPDATE command_receipts SET status = ${succeeded ? "side_effect_completed" : "side_effect_failed"}, error_code = ${errorCode}, updated_at = ${now} WHERE command_id = ${commandId}`;
			}),
		)
		.pipe(Effect.asVoid);
