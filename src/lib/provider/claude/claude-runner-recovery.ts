import type { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import type { TurnResult } from "../types.js";
import {
	type ClaudeRunnerSocket,
	claudeRunnerSinkId,
} from "./claude-runner-protocol.js";
import type {
	ClaudeSessionFailure,
	ClaudeSessionTurn,
} from "./claude-session-runner.js";

/** Reattach the outbox waiter to its original command, never start a second turn. */
export const recoverClaudeRunnerCommands = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	connection: ClaudeRunnerSocket,
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{
			command_id: string;
			payload_json: string;
			attempt_count: number;
		}>`SELECT command_id, payload_json, attempt_count FROM provider_command_outbox WHERE session_id = ${sessionId} AND status = 'running' AND effect_type = 'send_turn' ORDER BY request_sequence`;
		return rows.map((row) =>
			connection
				.commandEffect(
					row.command_id,
					{
						type: "send-turn",
						sinkId: claudeRunnerSinkId(row.command_id, row.attempt_count),
						aborted: false,
						input: {
							...(JSON.parse(row.payload_json) as ClaudeSessionTurn),
							commandId: row.command_id,
							commandAttempt: row.attempt_count,
						},
					},
					row.attempt_count,
				)
				.pipe(
					Effect.matchEffect({
						onSuccess: (result) =>
							settleClaudeRunnerCommand(sql, sessionId, row.command_id, result),
						onFailure: (failure) =>
							settleClaudeRunnerCommand(
								sql,
								sessionId,
								row.command_id,
								undefined,
								failure,
							),
					}),
				),
		);
	});

const settleClaudeRunnerCommand = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	commandId: string,
	result?: TurnResult,
	failure?: ClaudeSessionFailure,
) =>
	sql
		.withTransaction(
			Effect.gen(function* () {
				const rows = yield* sql<{
					attempt_count: number;
				}>`SELECT attempt_count FROM provider_command_outbox WHERE command_id = ${commandId} AND session_id = ${sessionId} AND status = 'running'`;
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
				yield* sql`UPDATE provider_command_outbox SET status = ${succeeded ? "completed" : retryable ? "retryable_failed" : "failed"}, error_code = ${errorCode}, next_attempt_at = ${retryAt}, updated_at = ${now} WHERE command_id = ${commandId} AND session_id = ${sessionId} AND status = 'running'`;
				yield* sql`UPDATE command_receipts SET status = ${succeeded ? "side_effect_completed" : "side_effect_failed"}, error_code = ${errorCode}, updated_at = ${now} WHERE command_id = ${commandId}`;
			}),
		)
		.pipe(Effect.asVoid);
