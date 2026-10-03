import type { SqlClient } from "@effect/sql";
import { type Deferred, Effect, FiberRef } from "effect";
import type { PermissionResponse } from "../types.js";
import type { ClaudeSessionOutputReply } from "./claude-session-runner.js";

/** Only the server consumes this context and writes the durable checkpoint. */
export interface ClaudeRunnerOutputReceipt {
	readonly runnerId: string;
	readonly sequence: number;
	readonly attachmentId: string;
	readonly committed: Deferred.Deferred<void>;
	/** Called only after this receipt claims and commits its event transaction. */
	readonly onCommitted?: (() => void) | undefined;
	consumed: boolean;
}

export const currentClaudeRunnerOutput = FiberRef.unsafeMake<
	ClaudeRunnerOutputReceipt | undefined
>(undefined);

/** Stopped owners replay before the relay's publishing edge is available. */
export const replayingStoppedClaudeRunner = FiberRef.unsafeMake(false);

export const currentClaudeRunnerPermissionReply = FiberRef.unsafeMake<
	| {
			readonly sessionId: string;
			readonly requestId: string;
			readonly response: PermissionResponse;
	  }
	| undefined
>(undefined);

export const makeClaudeRunnerReceiptStore = (sql: SqlClient.SqlClient) =>
	Effect.gen(function* () {
		yield* sql`CREATE TABLE IF NOT EXISTS claude_runner_cursors (
		runner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, result_json TEXT NOT NULL DEFAULT '{}',
		attachment_id TEXT NOT NULL DEFAULT ''
	)`;
		const columns = yield* sql<{
			name: string;
		}>`PRAGMA table_info(claude_runner_cursors)`;
		if (!columns.some(({ name }) => name === "attachment_id"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN attachment_id TEXT NOT NULL DEFAULT ''`;
		yield* sql`CREATE TABLE IF NOT EXISTS claude_runner_replies (
			runner_id TEXT NOT NULL, sequence INTEGER NOT NULL, result_json TEXT NOT NULL,
			PRIMARY KEY (runner_id, sequence)
		)`;
		yield* sql`CREATE TABLE IF NOT EXISTS claude_runner_permission_replies (
			session_id TEXT NOT NULL, request_id TEXT NOT NULL, response_json TEXT NOT NULL,
			PRIMARY KEY (session_id, request_id)
		)`;
		const read = (runnerId: string) =>
			sql<{
				sequence: number;
				result_json: string;
			}>`SELECT sequence, result_json FROM claude_runner_cursors WHERE runner_id = ${runnerId}`.pipe(
				Effect.map((rows) => ({
					sequence: rows[0]?.sequence ?? 0,
					result: JSON.parse(
						rows[0]?.result_json ?? "{}",
					) as ClaudeSessionOutputReply,
				})),
			);
		return {
			read,
			// Claim the attachment before reading its cursor. A previous writer either
			// committed before this transaction or is fenced by its attachment id.
			attach: (runnerId: string, attachmentId: string) =>
				sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`INSERT INTO claude_runner_cursors (runner_id, sequence, attachment_id) VALUES (${runnerId}, 0, ${attachmentId}) ON CONFLICT(runner_id) DO UPDATE SET attachment_id = excluded.attachment_id`;
						return yield* read(runnerId);
					}),
				),
			acknowledge: (
				runnerId: string,
				sequence: number,
				result: ClaudeSessionOutputReply = {},
				attachmentId: string,
			) => {
				const reply = JSON.stringify(result);
				const commit =
					sql`UPDATE claude_runner_cursors SET sequence = ${sequence}, result_json = ${reply}
			WHERE runner_id = ${runnerId} AND attachment_id = ${attachmentId}
			AND sequence BETWEEN ${sequence - 1} AND ${sequence}
			RETURNING sequence`.pipe(Effect.map((rows) => rows.length > 0));
				// A single statement commits atomically without extra transaction calls.
				if (result.history === undefined && result.children === undefined)
					return commit.pipe(Effect.asVoid);
				return sql.withTransaction(
					Effect.gen(function* () {
						if (!(yield* commit)) return;
						yield* sql`INSERT OR REPLACE INTO claude_runner_replies (runner_id, sequence, result_json) VALUES (${runnerId}, ${sequence}, ${reply})`;
					}),
				);
			},
			replyAt: (runnerId: string, sequence: number) =>
				sql<{
					result_json: string;
				}>`SELECT result_json FROM claude_runner_replies WHERE runner_id = ${runnerId} AND sequence = ${sequence}`.pipe(
					Effect.map(
						(rows) =>
							JSON.parse(
								rows[0]?.result_json ?? "{}",
							) as ClaudeSessionOutputReply,
					),
				),
		};
	});

export const commitClaudeRunnerOutput = (
	sql: SqlClient.SqlClient,
	receipt: ClaudeRunnerOutputReceipt,
) =>
	sql`UPDATE claude_runner_cursors SET sequence = ${receipt.sequence}, result_json = '{}'
		WHERE runner_id = ${receipt.runnerId} AND attachment_id = ${receipt.attachmentId}
		AND sequence = ${receipt.sequence - 1}
		RETURNING sequence`.pipe(Effect.map((rows) => rows.length > 0));

/** Later interaction events inherit an already-consumed output receipt. */
export const ownsClaudeRunnerAttachment = (
	sql: SqlClient.SqlClient,
	receipt: ClaudeRunnerOutputReceipt,
) =>
	sql`SELECT 1 FROM claude_runner_cursors WHERE runner_id = ${receipt.runnerId} AND attachment_id = ${receipt.attachmentId}`.pipe(
		Effect.map((rows) => rows.length > 0),
	);
