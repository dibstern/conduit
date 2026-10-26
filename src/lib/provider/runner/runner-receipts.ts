import { Clock, Context, type Deferred, Effect } from "effect";
import type { SqlClient } from "effect/sql";
import {
	flushPendingWrites,
	queuePendingWrite,
	schedulePendingWriteFlush,
} from "../../persistence/effect/commit-and-signal.js";
import type { PermissionResponse } from "../types.js";
import type { SessionOutputReply } from "./session-runner.js";

export interface RunnerRetirement {
	readonly runnerId: string;
	readonly sessionId: string;
	readonly driverKind: string;
	readonly pid?: number | undefined;
	readonly startTime?: string | undefined;
	readonly ownedRunIds: readonly string[];
	readonly retiredAt: number;
	readonly signalled: boolean;
}

const pendingRetirements = new WeakMap<
	SqlClient.SqlClient,
	Map<string, RunnerRetirement>
>();

export const hasPendingRunnerRetirement = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	runId: string,
) =>
	[...(pendingRetirements.get(sql)?.values() ?? [])].some(
		(retirement) =>
			retirement.sessionId === sessionId &&
			retirement.ownedRunIds.includes(runId),
	);

/** The receipt store owns the cursor schema; the seam receives only this opaque write. */
export const queueRunnerRetirement = (
	sql: SqlClient.SqlClient,
	retirement: RunnerRetirement,
) => {
	let pending = pendingRetirements.get(sql);
	if (pending === undefined) {
		pending = new Map();
		pendingRetirements.set(sql, pending);
	}
	const captured = { ...retirement, ownedRunIds: [...retirement.ownedRunIds] };
	pending.set(captured.runnerId, captured);
	queuePendingWrite(sql, `retirement:${captured.runnerId}`, {
		apply: sql`INSERT INTO claude_runner_cursors
			(runner_id, sequence, attachment_id, retired_at, session_id, pid, start_time, owned_run_ids, signalled, driver_kind)
			VALUES (${captured.runnerId}, 0, '', ${captured.retiredAt}, ${captured.sessionId}, ${captured.pid ?? null}, ${captured.startTime ?? null}, ${JSON.stringify(captured.ownedRunIds)}, ${captured.signalled ? 1 : 0}, ${captured.driverKind})
			ON CONFLICT(runner_id) DO UPDATE SET
			retired_at = COALESCE(claude_runner_cursors.retired_at, excluded.retired_at), attachment_id = '',
			session_id = excluded.session_id, pid = excluded.pid, start_time = excluded.start_time,
			owned_run_ids = excluded.owned_run_ids, signalled = MAX(claude_runner_cursors.signalled, excluded.signalled),
			driver_kind = excluded.driver_kind`.pipe(Effect.asVoid),
		committed: () => {
			if (pendingRetirements.get(sql)?.get(captured.runnerId) === captured)
				pendingRetirements.get(sql)?.delete(captured.runnerId);
		},
	});
};

export const flushRunnerRetirements = flushPendingWrites;

export interface RunnerCursorIdentity {
	readonly sessionId: string;
	readonly driverKind?: string | undefined;
	readonly pid?: number | undefined;
	readonly startTime?: string | undefined;
	readonly ownedRunIds?: readonly string[] | undefined;
}

/** Only the server consumes this context and writes the durable checkpoint. */
export interface RunnerOutputReceipt {
	readonly runnerId: string;
	readonly sequence: number;
	readonly attachmentId: string;
	/** Accepted Run ownership commits atomically with this output checkpoint. */
	readonly ownedRunId?: string | undefined;
	readonly committed: Deferred.Deferred<void>;
	/** Called only after this receipt claims and commits its event transaction. */
	readonly onCommitted?: (() => void) | undefined;
	consumed: boolean;
}

export const currentRunnerOutput = Context.Reference<
	RunnerOutputReceipt | undefined
>("conduit/currentRunnerOutput", { defaultValue: () => undefined });

export const currentRunnerProcessId = Context.Reference<string | undefined>(
	"conduit/currentRunnerProcessId",
	{ defaultValue: () => undefined },
);

export const currentRunnerPermissionReply = Context.Reference<
	| {
			readonly sessionId: string;
			readonly requestId: string;
			readonly response: PermissionResponse;
	  }
	| undefined
>("conduit/currentRunnerPermissionReply", { defaultValue: () => undefined });

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
		attachment_id TEXT NOT NULL DEFAULT '', retired_at INTEGER,
		pid INTEGER, start_time TEXT, owned_run_ids TEXT NOT NULL DEFAULT '[]',
		session_id TEXT NOT NULL DEFAULT '', signalled INTEGER NOT NULL DEFAULT 0,
		driver_kind TEXT NOT NULL DEFAULT 'claude'
	)`;
		const columns = yield* sql<{
			name: string;
		}>`PRAGMA table_info(claude_runner_cursors)`;
		if (!columns.some(({ name }) => name === "attachment_id"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN attachment_id TEXT NOT NULL DEFAULT ''`;
		if (!columns.some(({ name }) => name === "retired_at"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN retired_at INTEGER`;
		if (!columns.some(({ name }) => name === "pid"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN pid INTEGER`;
		if (!columns.some(({ name }) => name === "start_time"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN start_time TEXT`;
		if (!columns.some(({ name }) => name === "owned_run_ids"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN owned_run_ids TEXT NOT NULL DEFAULT '[]'`;
		// Retired rows must remain recoverable after their registration vanishes.
		if (!columns.some(({ name }) => name === "session_id"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`;
		if (!columns.some(({ name }) => name === "signalled"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN signalled INTEGER NOT NULL DEFAULT 0`;
		if (!columns.some(({ name }) => name === "driver_kind"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN driver_kind TEXT NOT NULL DEFAULT 'claude'`;
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
			owners: (runnerIds: readonly string[]) =>
				runnerIds.length === 0
					? Effect.succeed([])
					: sql<{
							runner_id: string;
							owned_run_ids: string;
						}>`SELECT runner_id, owned_run_ids
					FROM claude_runner_cursors WHERE runner_id IN ${sql.in(runnerIds)}`.pipe(
							Effect.map((rows) =>
								rows.map((row) => ({
									runnerId: row.runner_id,
									ownedRunIds: JSON.parse(
										row.owned_run_ids,
									) as readonly string[],
								})),
							),
						),
			retirements: (runnerIds?: readonly string[]) =>
				sql<{
					runner_id: string;
					session_id: string;
					driver_kind: string;
					pid: number | null;
					start_time: string | null;
					owned_run_ids: string;
					retired_at: number;
					signalled: number;
				}>`SELECT runner_id, session_id, driver_kind, pid, start_time, owned_run_ids, retired_at, signalled
					FROM claude_runner_cursors WHERE retired_at IS NOT NULL`.pipe(
					Effect.map((rows): readonly RunnerRetirement[] =>
						rows
							.filter((row) => !runnerIds || runnerIds.includes(row.runner_id))
							.map((row) => ({
								runnerId: row.runner_id,
								sessionId: row.session_id,
								driverKind: row.driver_kind,
								...(row.pid === null ? {} : { pid: row.pid }),
								...(row.start_time === null
									? {}
									: { startTime: row.start_time }),
								ownedRunIds: JSON.parse(row.owned_run_ids) as readonly string[],
								retiredAt: row.retired_at,
								signalled: row.signalled !== 0,
							})),
					),
				),
			retire: (
				identity: RunnerCursorIdentity & {
					readonly runnerId: string;
					readonly retiredAt?: number | undefined;
					readonly signalled?: boolean | undefined;
				},
			) =>
				Effect.gen(function* () {
					const retiredAt =
						identity.retiredAt ?? (yield* Clock.currentTimeMillis);
					queueRunnerRetirement(sql, {
						...identity,
						ownedRunIds: identity.ownedRunIds ?? [],
						driverKind: identity.driverKind ?? "claude",
						retiredAt,
						signalled: identity.signalled ?? false,
					});
					yield* schedulePendingWriteFlush(sql);
				}),
			pruneRetired: (runnerId: string) =>
				Effect.gen(function* () {
					queuePendingWrite(sql, `retirement:${runnerId}`, {
						apply:
							sql`DELETE FROM claude_runner_cursors WHERE runner_id = ${runnerId} AND retired_at IS NOT NULL`.pipe(
								Effect.asVoid,
							),
						committed: () => pendingRetirements.get(sql)?.delete(runnerId),
					});
					yield* flushPendingWrites(sql);
				}),
			// Atomically claim and read the cursor without masked transaction acquisition.
			attach: (
				runnerId: string,
				attachmentId: string,
				identity?: RunnerCursorIdentity,
			) =>
				sql<{
					sequence: number;
					result_json: string;
				}>`INSERT INTO claude_runner_cursors (runner_id, sequence, attachment_id, session_id, pid, start_time, owned_run_ids, driver_kind)
					VALUES (${runnerId}, 0, ${attachmentId}, ${identity?.sessionId ?? ""}, ${identity?.pid ?? null}, ${identity?.startTime ?? null}, ${JSON.stringify(identity?.ownedRunIds ?? [])}, ${identity?.driverKind ?? "claude"})
					ON CONFLICT(runner_id) DO UPDATE SET attachment_id = excluded.attachment_id,
					session_id = COALESCE(NULLIF(excluded.session_id, ''), claude_runner_cursors.session_id),
					pid = COALESCE(excluded.pid, claude_runner_cursors.pid), start_time = COALESCE(excluded.start_time, claude_runner_cursors.start_time),
					owned_run_ids = CASE WHEN ${identity?.ownedRunIds !== undefined} THEN excluded.owned_run_ids ELSE claude_runner_cursors.owned_run_ids END,
					driver_kind = CASE WHEN ${identity?.driverKind !== undefined} THEN excluded.driver_kind ELSE claude_runner_cursors.driver_kind END
					WHERE claude_runner_cursors.retired_at IS NULL
				RETURNING sequence, result_json`.pipe(
					Effect.map((rows) => ({
						sequence: rows[0]?.sequence ?? 0,
						result: JSON.parse(
							rows[0]?.result_json ?? "{}",
						) as SessionOutputReply,
					})),
				),
			acknowledge: (
				runnerId: string,
				sequence: number,
				result: SessionOutputReply = {},
				attachmentId: string,
			) => {
				const reply = JSON.stringify(result);
				return flushPendingWrites(
					sql,
					sql`UPDATE claude_runner_cursors SET sequence = ${sequence}, result_json = ${reply}
			WHERE runner_id = ${runnerId} AND attachment_id = ${attachmentId}
			AND sequence BETWEEN ${sequence - 1} AND ${sequence}
				RETURNING sequence`.pipe(Effect.asVoid),
					{ runnerId },
				);
			},
		};
	});

export const commitRunnerOutput = (
	sql: SqlClient.SqlClient,
	receipt: RunnerOutputReceipt,
) =>
	sql`UPDATE claude_runner_cursors SET sequence = ${receipt.sequence}, result_json = '{}',
	owned_run_ids = CASE WHEN ${receipt.ownedRunId ?? null} IS NULL
		OR EXISTS (SELECT 1 FROM json_each(owned_run_ids) WHERE value = ${receipt.ownedRunId ?? null})
		THEN owned_run_ids ELSE json_insert(owned_run_ids, '$[#]', ${receipt.ownedRunId ?? null}) END
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
