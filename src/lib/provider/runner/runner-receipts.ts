import { type Deferred, Effect, References as FiberRef } from "effect";
import type { SqlClient } from "effect/sql";
import type { PermissionResponse } from "../types.js";
import type { SessionOutputReply } from "./session-runner.js";

/** Only the server consumes this context and writes the durable checkpoint. */
export interface RunnerOutputReceipt {
	readonly runnerId: string;
	readonly sequence: number;
	readonly attachmentId: string;
	readonly committed: Deferred.Deferred<void>;
	/** Called only after this receipt claims and commits its event transaction. */
	readonly onCommitted?: (() => void) | undefined;
	consumed: boolean;
}

export const currentRunnerOutput = FiberRef.unsafeMake<
	RunnerOutputReceipt | undefined
>(undefined);

export const currentRunnerPermissionReply = FiberRef.unsafeMake<
	| {
			readonly sessionId: string;
			readonly requestId: string;
			readonly response: PermissionResponse;
	  }
	| undefined
>(undefined);

// Keep the persisted table names for retained runners and existing databases.
// Ingestion writes this table for every runner, including in-process
// ones that never build a receipt store, so both owners create it.
export const createRunnerPermissionReplies = (sql: SqlClient.SqlClient) =>
	sql`CREATE TABLE IF NOT EXISTS claude_runner_permission_replies (
		session_id TEXT NOT NULL, request_id TEXT NOT NULL, response_json TEXT NOT NULL,
		PRIMARY KEY (session_id, request_id)
	)`;

export const makeRunnerReceiptStore = (sql: SqlClient.SqlClient) =>
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
		yield* createRunnerPermissionReplies(sql);
		const read = (runnerId: string) =>
			sql<{
				sequence: number;
				result_json: string;
			}>`SELECT sequence, result_json FROM claude_runner_cursors WHERE runner_id = ${runnerId}`.pipe(
				Effect.map((rows) => ({
					sequence: rows[0]?.sequence ?? 0,
					result: JSON.parse(
						rows[0]?.result_json ?? "{}",
					) as SessionOutputReply,
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
				result: SessionOutputReply = {},
				attachmentId: string,
			) => {
				const reply = JSON.stringify(result);
				return sql`UPDATE claude_runner_cursors SET sequence = ${sequence}, result_json = ${reply}
			WHERE runner_id = ${runnerId} AND attachment_id = ${attachmentId}
			AND sequence BETWEEN ${sequence - 1} AND ${sequence}
				RETURNING sequence`.pipe(Effect.asVoid);
			},
		};
	});

export const commitRunnerOutput = (
	sql: SqlClient.SqlClient,
	receipt: RunnerOutputReceipt,
) =>
	sql`UPDATE claude_runner_cursors SET sequence = ${receipt.sequence}, result_json = '{}'
		WHERE runner_id = ${receipt.runnerId} AND attachment_id = ${receipt.attachmentId}
		AND sequence = ${receipt.sequence - 1}
		RETURNING sequence`.pipe(Effect.map((rows) => rows.length > 0));

/** Later interaction events inherit an already-consumed output receipt. */
export const ownsRunnerAttachment = (
	sql: SqlClient.SqlClient,
	receipt: RunnerOutputReceipt,
) =>
	sql`SELECT 1 FROM claude_runner_cursors WHERE runner_id = ${receipt.runnerId} AND attachment_id = ${receipt.attachmentId}`.pipe(
		Effect.map((rows) => rows.length > 0),
	);
