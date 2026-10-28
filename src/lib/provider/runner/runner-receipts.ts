import { Context, Data, type Deferred, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { flushPendingWrites } from "../../persistence/effect/commit-and-signal.js";
import type { PermissionResponse } from "../types.js";
import { legacyRunnerRanking } from "./runner-registry.js";
import type { SessionOutputReply } from "./session-runner.js";

export type RunnerRole = "serving" | "candidate";
export type StopReason =
	| {
			readonly _tag:
				| "Explicit"
				| "EndSession"
				| "ProjectRemoved"
				| "Idle"
				| "Exited"
				| "CandidateAbandoned";
	  }
	| { readonly _tag: "Superseded"; readonly successor: string };
export interface RunnerRow {
	readonly runnerId: string;
	readonly sessionId: string;
	readonly driverKind: string;
	readonly identity: RunnerProcessIdentity;
	readonly reaper: RunnerMember | undefined;
	readonly role: RunnerRole;
	readonly retiredAt: number | null;
	readonly sequence: number;
}

export class RunnerSlotError extends Data.TaggedError("RunnerSlotError")<{
	readonly runnerId: string;
	readonly cause: string;
}> {}

const Member = Schema.Struct({
	pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	startTime: Schema.NonEmptyString,
});
export type RunnerMember = typeof Member.Type;
const SignalAttempt = Schema.Struct({
	signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
	/** Older logs predate a grace clock anchored to the actual TERM attempt. */
	at: Schema.optionalKey(Schema.Number),
	target: Schema.Number.check(Schema.isInt()),
	members: Schema.Array(Member),
	outcome: Schema.Literals(["delivered", "refused", "failed"]),
});
export type RunnerSignalAttempt = typeof SignalAttempt.Type;
export type RunnerProcessIdentity =
	| {
			readonly tag: "Verified";
			readonly pid: number;
			readonly startTime: string;
	  }
	| { readonly tag: "Unverifiable"; readonly pid?: number };
const Signal = Schema.Union([
	Schema.Struct({
		tag: Schema.Literal("None"),
		members: Schema.optionalKey(Schema.Array(Member)),
	}),
	Schema.Struct({
		tag: Schema.Literal("TermSent"),
		members: Schema.Array(Member),
	}),
	Schema.Struct({
		tag: Schema.Literal("KillSent"),
		members: Schema.Array(Member),
		sent: Schema.Array(Member),
	}),
]);
export type RunnerSignal = typeof Signal.Type;
const Owned = Schema.fromJsonString(Schema.Array(Schema.NonEmptyString));
const Reply = Schema.fromJsonString(
	Schema.StructWithRest(
		Schema.Struct({
			subagentTranscript: Schema.optionalKey(
				Schema.Struct({
					messages: Schema.Array(
						Schema.Struct({
							id: Schema.String,
							role: Schema.Literals(["user", "assistant"]),
						}),
					),
					parts: Schema.Array(
						Schema.Struct({
							id: Schema.String,
							messageId: Schema.String,
							type: Schema.String,
							text: Schema.NullOr(Schema.String),
							status: Schema.NullOr(Schema.String),
						}),
					),
				}),
			),
		}),
		[Schema.Record(Schema.String, Schema.Unknown)],
	),
);
const RetirementRow = Schema.Struct({
	runner_id: Schema.NonEmptyString,
	session_id: Schema.String,
	role: Schema.Literals(["serving", "candidate"]),
	driver_kind: Schema.NonEmptyString,
	pid: Schema.NullOr(Member.fields.pid),
	start_time: Schema.NullOr(Schema.NonEmptyString),
	owned_run_ids: Owned,
	retired_at: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0),
	),
	signalled: Schema.Literals([0, 1]),
	retirement_state: Schema.Literals(["Watching", "GonePending", "Complete"]),
	signal_state: Schema.Literals(["None", "TermSent", "KillSent"]),
	signal_members: Schema.fromJsonString(Schema.Array(Member)),
	signal_sent_members: Schema.fromJsonString(Schema.Array(Member)),
	reaper_pid: Schema.NullOr(Member.fields.pid),
	reaper_start_time: Schema.NullOr(Schema.NonEmptyString),
	member_snapshot: Schema.fromJsonString(Schema.Array(Member)),
	signal_log: Schema.fromJsonString(Schema.Array(SignalAttempt)),
	stop_state: Schema.Literals([
		"Requested",
		"Escalating",
		"Escalated",
		"Gone",
		"Settled",
	]),
	stop_reason: Schema.String,
	stop_started_at: Schema.NullOr(Schema.Number),
});

export class RunnerRetirementDecodeError extends Data.TaggedError(
	"RunnerRetirementDecodeError",
)<{
	readonly runnerId: string;
	readonly cause: unknown;
}> {}

export interface RunnerRetirement {
	readonly runnerId: string;
	readonly sessionId: string;
	readonly driverKind: string;
	readonly identity: RunnerProcessIdentity;
	readonly retirement:
		| { readonly tag: "Watching" }
		| { readonly tag: "GonePending"; readonly owned: readonly string[] }
		| { readonly tag: "Complete" };
	readonly signal: RunnerSignal;
	readonly reaper: RunnerMember | undefined;
	readonly members: readonly RunnerMember[];
	readonly signalLog: readonly RunnerSignalAttempt[];
	readonly ownedRunIds: readonly string[];
	readonly retiredAt: number;
	readonly stopState?:
		| "Requested"
		| "Escalating"
		| "Escalated"
		| "Gone"
		| "Settled";
	readonly stopReason?: string;
	readonly stopStartedAt?: number;
}

const decodeRetirement = (raw: { readonly runner_id: string }) =>
	Effect.gen(function* () {
		const row = yield* Schema.decodeUnknownEffect(RetirementRow)(raw);
		if (
			(row.pid === null && row.start_time !== null) ||
			(row.reaper_pid === null) !== (row.reaper_start_time === null) ||
			(row.retirement_state === "Complete" && row.owned_run_ids.length > 0) ||
			(row.retirement_state === "GonePending" && row.owned_run_ids.length === 0)
		)
			return yield* Effect.fail("Inconsistent retirement state");
		const signal = yield* Schema.decodeUnknownEffect(Signal)(
			row.signal_state === "None"
				? row.signalled === 1
					? { tag: "KillSent", members: [], sent: [] }
					: {
							tag: "None",
							...(row.signal_members.length
								? { members: row.signal_members }
								: {}),
						}
				: {
						tag: row.signal_state,
						members: row.signal_members,
						sent: row.signal_sent_members,
					},
		);
		return {
			runnerId: row.runner_id,
			sessionId: row.session_id,
			driverKind: row.driver_kind,
			identity:
				row.pid !== null && row.start_time !== null
					? { tag: "Verified", pid: row.pid, startTime: row.start_time }
					: {
							tag: "Unverifiable",
							...(row.pid === null ? {} : { pid: row.pid }),
						},
			retirement:
				row.retirement_state === "GonePending"
					? { tag: "GonePending", owned: row.owned_run_ids }
					: { tag: row.retirement_state },
			signal,
			reaper:
				row.reaper_pid !== null && row.reaper_start_time !== null
					? { pid: row.reaper_pid, startTime: row.reaper_start_time }
					: undefined,
			members: mergeRunnerMembers(
				row.member_snapshot,
				row.signal_members,
				row.pid !== null && row.start_time !== null
					? [{ pid: row.pid, startTime: row.start_time }]
					: [],
				row.reaper_pid !== null && row.reaper_start_time !== null
					? [{ pid: row.reaper_pid, startTime: row.reaper_start_time }]
					: [],
			),
			signalLog: row.signal_log,
			ownedRunIds: row.owned_run_ids,
			retiredAt: row.retired_at,
			stopState: row.stop_state,
			stopReason: row.stop_reason,
			...(row.stop_started_at === null
				? {}
				: { stopStartedAt: row.stop_started_at }),
		} satisfies RunnerRetirement;
	}).pipe(
		Effect.mapError(
			(cause) =>
				new RunnerRetirementDecodeError({ runnerId: raw.runner_id, cause }),
		),
		Effect.tapError((error) =>
			Effect.logWarning(
				`Rejected malformed runner retirement: runnerId=${error.runnerId}`,
				error,
			),
		),
	);

export const mergeRunnerMembers = (
	...snapshots: readonly (readonly RunnerMember[])[]
) => [
	...new Map(
		snapshots
			.flat()
			.map((member) => [`${member.pid}:${member.startTime}`, member]),
	).values(),
];

export interface RunnerCursorIdentity {
	readonly sessionId: string;
	readonly driverKind?: string | undefined;
	readonly pid?: number | undefined;
	readonly startTime?: string | undefined;
	readonly ownedRunIds?: readonly string[] | undefined;
	readonly reaper?: RunnerMember | undefined;
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

export const makeRunnerReceiptStore = (
	sql: SqlClient.SqlClient,
	options: { readonly configDir?: string } = {},
) =>
	Effect.gen(function* () {
		yield* sql`CREATE TABLE IF NOT EXISTS claude_runner_cursors (
		runner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, result_json TEXT NOT NULL DEFAULT '{}',
		attachment_id TEXT NOT NULL DEFAULT '', retired_at INTEGER,
		pid INTEGER, start_time TEXT, owned_run_ids TEXT NOT NULL DEFAULT '[]',
		session_id TEXT NOT NULL DEFAULT '', signalled INTEGER NOT NULL DEFAULT 0,
		driver_kind TEXT NOT NULL DEFAULT 'claude', retirement_state TEXT NOT NULL DEFAULT 'Watching',
		signal_state TEXT NOT NULL DEFAULT 'None', signal_members TEXT NOT NULL DEFAULT '[]', signal_sent_members TEXT NOT NULL DEFAULT '[]',
		reaper_pid INTEGER, reaper_start_time TEXT, member_snapshot TEXT NOT NULL DEFAULT '[]', signal_log TEXT NOT NULL DEFAULT '[]',
		stop_state TEXT NOT NULL DEFAULT 'Requested', stop_reason TEXT NOT NULL DEFAULT 'Provider process stopped', stop_started_at INTEGER,
		role TEXT NOT NULL DEFAULT 'serving'
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
		if (!columns.some(({ name }) => name === "retirement_state"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN retirement_state TEXT NOT NULL DEFAULT 'Watching'`;
		if (!columns.some(({ name }) => name === "signal_state")) {
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN signal_state TEXT NOT NULL DEFAULT 'None'`;
			yield* sql`UPDATE claude_runner_cursors SET signal_state = 'KillSent' WHERE signalled = 1`;
		}
		if (!columns.some(({ name }) => name === "signal_members"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN signal_members TEXT NOT NULL DEFAULT '[]'`;
		if (!columns.some(({ name }) => name === "signal_sent_members"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN signal_sent_members TEXT NOT NULL DEFAULT '[]'`;
		if (!columns.some(({ name }) => name === "reaper_pid"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN reaper_pid INTEGER`;
		if (!columns.some(({ name }) => name === "reaper_start_time"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN reaper_start_time TEXT`;
		if (!columns.some(({ name }) => name === "member_snapshot"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN member_snapshot TEXT NOT NULL DEFAULT '[]'`;
		if (!columns.some(({ name }) => name === "signal_log"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN signal_log TEXT NOT NULL DEFAULT '[]'`;
		if (!columns.some(({ name }) => name === "stop_state"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN stop_state TEXT NOT NULL DEFAULT 'Requested'`;
		if (!columns.some(({ name }) => name === "stop_reason"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN stop_reason TEXT NOT NULL DEFAULT 'Provider process stopped'`;
		if (!columns.some(({ name }) => name === "stop_started_at"))
			yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN stop_started_at INTEGER`;
		yield* flushPendingWrites(
			sql,
			Effect.gen(function* () {
				if (!columns.some(({ name }) => name === "role"))
					yield* sql`ALTER TABLE claude_runner_cursors ADD COLUMN role TEXT NOT NULL DEFAULT 'serving'`;
				const slotIndex =
					yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_runner_serving_session'`;
				if (slotIndex.length === 0) {
					// Legacy-only role ranking. Delete with 32.13 after retained rows migrate.
					const configDir = options.configDir;
					const registry: ReturnType<typeof legacyRunnerRanking> = configDir
						? yield* Effect.sync(() => legacyRunnerRanking(configDir))
						: new Map();
					const live = yield* sql<{
						runner_id: string;
						session_id: string;
						sequence: number;
					}>`SELECT runner_id, session_id, sequence FROM claude_runner_cursors WHERE retired_at IS NULL AND role = 'serving' ORDER BY sequence DESC, rowid DESC`;
					const sessions = new Map<string, (typeof live)[number][]>();
					for (const row of live)
						sessions.set(row.session_id, [
							...(sessions.get(row.session_id) ?? []),
							row,
						]);
					for (const rows of sessions.values()) {
						const rank = (runnerId: string) =>
							registry.get(runnerId)?.role === "candidate"
								? 2
								: registry.get(runnerId)?.role === "retiring"
									? 1
									: 0;
						rows.sort(
							(a, b) =>
								rank(a.runner_id) - rank(b.runner_id) ||
								(registry.get(b.runner_id)?.registeredAt ?? 0) -
									(registry.get(a.runner_id)?.registeredAt ?? 0) ||
								b.sequence - a.sequence,
						);
						for (const row of rows.slice(1))
							yield* sql`UPDATE claude_runner_cursors SET role = 'candidate' WHERE runner_id = ${row.runner_id}`;
					}
				}
				yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_serving_session ON claude_runner_cursors(session_id) WHERE retired_at IS NULL AND role = 'serving'`;
			}),
		);
		yield* createRunnerPermissionReplies(sql);
		const read = (runnerId: string) =>
			sql<{
				sequence: number;
				result_json: string;
			}>`SELECT sequence, result_json FROM claude_runner_cursors WHERE runner_id = ${runnerId}`.pipe(
				Effect.flatMap((rows) =>
					Schema.decodeUnknownEffect(Reply)(rows[0]?.result_json ?? "{}").pipe(
						Effect.map((result) => ({
							sequence: rows[0]?.sequence ?? 0,
							result,
						})),
					),
				),
			);
		const rawRunner = (runnerId: string) =>
			sql<{
				runner_id: string;
				retired_at: number | null;
				role: RunnerRole;
			}>`SELECT *, COALESCE(retired_at, 0) AS retired_at FROM claude_runner_cursors WHERE runner_id = ${runnerId}`;
		const saveStop = (record: RunnerRetirement, reason: StopReason) =>
			sql`INSERT INTO claude_runner_cursors (runner_id, sequence, attachment_id, session_id, driver_kind, retired_at, pid, start_time, reaper_pid, reaper_start_time, member_snapshot, stop_reason)
				VALUES (${record.runnerId}, 0, '', ${record.sessionId}, ${record.driverKind}, ${record.retiredAt}, ${record.identity.pid ?? null}, ${record.identity.tag === "Verified" ? record.identity.startTime : null}, ${record.reaper?.pid ?? null}, ${record.reaper?.startTime ?? null}, ${JSON.stringify(record.members)}, ${JSON.stringify(reason)})
				ON CONFLICT(runner_id) DO UPDATE SET retired_at = excluded.retired_at, attachment_id = '', session_id = excluded.session_id, driver_kind = excluded.driver_kind, pid = excluded.pid, start_time = excluded.start_time, reaper_pid = excluded.reaper_pid, reaper_start_time = excluded.reaper_start_time, member_snapshot = excluded.member_snapshot, stop_state = 'Requested', stop_reason = excluded.stop_reason`.pipe(
				Effect.asVoid,
			);
		/** Runs inside the caller's write; it never acquires a second writer. */
		const requestStopMutation = (
			record: RunnerRetirement,
			reason: StopReason = { _tag: "Explicit" },
			candidates: readonly RunnerRetirement[] = [],
		) =>
			Effect.gen(function* () {
				let committed = record;
				const [existingRaw] = yield* rawRunner(record.runnerId);
				const [fence] = yield* sql<{
					retired_at: number | null;
					role: RunnerRole;
					session_id: string;
				}>`SELECT retired_at, role, session_id FROM claude_runner_cursors WHERE runner_id = ${record.runnerId}`;
				if (existingRaw) {
					const existing = yield* decodeRetirement(existingRaw);
					if (fence?.session_id !== record.sessionId)
						return yield* new RunnerSlotError({
							runnerId: record.runnerId,
							cause: "Runner session changed",
						});
					if (fence?.retired_at !== null) {
						if (
							reason._tag === "Superseded" &&
							existing.stopReason !== JSON.stringify(reason)
						)
							return yield* new RunnerSlotError({
								runnerId: record.runnerId,
								cause: "Another Stop already committed",
							});
						return existing;
					}
				}
				if (reason._tag === "Superseded") {
					const [successor] = yield* sql<{
						runner_id: string;
					}>`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${reason.successor} AND session_id = ${record.sessionId} AND retired_at IS NULL AND role = 'candidate'`;
					const held =
						yield* sql`SELECT 1 FROM provider_runs WHERE runner_id = ${record.runnerId} AND status IN ('pending', 'running') LIMIT 1`;
					if (
						!fence ||
						fence.role !== "serving" ||
						!successor ||
						held.length > 0
					)
						return yield* new RunnerSlotError({
							runnerId: record.runnerId,
							cause: "Runner swap refused",
						});
					const [rawSuccessor] = yield* rawRunner(reason.successor);
					if (rawSuccessor) yield* decodeRetirement(rawSuccessor);
				} else if (fence?.role === "serving") {
					const liveCandidates = yield* sql<{
						runner_id: string;
					}>`SELECT runner_id FROM claude_runner_cursors WHERE session_id = ${record.sessionId} AND role = 'candidate' AND retired_at IS NULL`;
					for (const candidate of liveCandidates) {
						const snapshot = candidates.find(
							(row) =>
								row.runnerId === candidate.runner_id &&
								row.sessionId === record.sessionId,
						);
						if (!snapshot)
							return yield* new RunnerSlotError({
								runnerId: candidate.runner_id,
								cause: "Candidate snapshot missing",
							});
						const [raw] = yield* rawRunner(candidate.runner_id);
						if (raw) yield* decodeRetirement(raw);
						yield* saveStop(snapshot, { _tag: "CandidateAbandoned" });
						const [savedCandidate] = yield* rawRunner(candidate.runner_id);
						if (savedCandidate) yield* decodeRetirement(savedCandidate);
					}
				}
				// New intents never write owned_run_ids; legacy lists survive.
				yield* saveStop(record, reason);
				if (reason._tag === "Superseded")
					yield* sql`UPDATE claude_runner_cursors SET role = 'serving' WHERE runner_id = ${reason.successor}`;
				const [saved] = yield* rawRunner(record.runnerId);
				if (saved) committed = yield* decodeRetirement(saved);
				return committed;
			});
		return {
			read,
			register: (
				runnerId: string,
				identity: RunnerCursorIdentity,
				role: RunnerRole,
			) =>
				flushPendingWrites(
					sql,
					Effect.gen(function* () {
						const existing = yield* rawRunner(runnerId);
						if (existing[0]) {
							yield* decodeRetirement(existing[0]);
							return yield* new RunnerSlotError({
								runnerId,
								cause: "Runner is already registered",
							});
						}
						if (role === "candidate") {
							const serving =
								yield* sql`SELECT 1 FROM claude_runner_cursors WHERE session_id = ${identity.sessionId} AND role = 'serving' AND retired_at IS NULL`;
							if (serving.length === 0)
								return yield* new RunnerSlotError({
									runnerId,
									cause: "Session has no serving runner for its candidate",
								});
						}
						yield* sql`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, driver_kind, pid, start_time, reaper_pid, reaper_start_time, role)
					VALUES (${runnerId}, 0, ${identity.sessionId}, ${identity.driverKind ?? "claude"}, ${identity.pid ?? null}, ${identity.startTime ?? null}, ${identity.reaper?.pid ?? null}, ${identity.reaper?.startTime ?? null}, ${role})`;
						const [saved] = yield* rawRunner(runnerId);
						if (saved) yield* decodeRetirement(saved);
					}),
				),
			runners: () =>
				sql<{
					runner_id: string;
					role: string;
					retired_at: number | null;
					sequence: number;
				}>`SELECT * FROM claude_runner_cursors ORDER BY rowid`.pipe(
					Effect.flatMap((rows) =>
						Effect.partition(rows, (row) =>
							Effect.gen(function* () {
								const normalized = {
									...row,
									retired_at: row.retired_at ?? 0,
								};
								const record = yield* decodeRetirement(normalized);
								const role = yield* Schema.decodeUnknownEffect(
									Schema.Literals(["serving", "candidate"]),
								)(row.role).pipe(
									Effect.mapError(
										(cause) =>
											new RunnerRetirementDecodeError({
												runnerId: row.runner_id,
												cause,
											}),
									),
								);
								return {
									runnerId: record.runnerId,
									sessionId: record.sessionId,
									driverKind: record.driverKind,
									identity: record.identity,
									reaper: record.reaper,
									role,
									retiredAt: row.retired_at,
									sequence: row.sequence,
								} satisfies RunnerRow;
							}),
						),
					),
					Effect.map(([rows, rejected]) => ({ rows, rejected })),
				),
			/** Retirement and slot promotion share dispatch's writer lock. */
			requestStopMutation,
			requestStop: (
				record: RunnerRetirement,
				reason: StopReason = { _tag: "Explicit" },
				candidates: readonly RunnerRetirement[] = [],
			) =>
				Effect.gen(function* () {
					let committed = record;
					yield* flushPendingWrites(
						sql,
						requestStopMutation(record, reason, candidates).pipe(
							Effect.tap((saved) =>
								Effect.sync(() => {
									committed = saved;
								}),
							),
						),
					);
					return committed;
				}),
			stopProgress: (record: RunnerRetirement) =>
				flushPendingWrites(
					sql,
					sql`UPDATE claude_runner_cursors SET stop_state = ${record.stopState ?? "Requested"}, stop_started_at = ${record.stopStartedAt ?? null},
					retirement_state = CASE WHEN ${record.stopState === "Gone" || record.stopState === "Settled"} THEN CASE WHEN json_array_length(owned_run_ids) = 0 THEN 'Complete' ELSE 'GonePending' END ELSE retirement_state END
					WHERE runner_id = ${record.runnerId} AND retired_at IS NOT NULL`.pipe(
						Effect.asVoid,
					),
				),
			commitRetirement: (record: RunnerRetirement) =>
				flushPendingWrites(
					sql,
					sql`INSERT INTO claude_runner_cursors (runner_id, sequence, attachment_id, session_id, driver_kind, retired_at, pid, start_time, reaper_pid, reaper_start_time, member_snapshot)
				VALUES (${record.runnerId}, 0, '', ${record.sessionId}, ${record.driverKind}, ${record.retiredAt}, ${record.identity.pid ?? null}, ${record.identity.tag === "Verified" ? record.identity.startTime : null}, ${record.reaper?.pid ?? null}, ${record.reaper?.startTime ?? null}, ${JSON.stringify(record.members)})
				ON CONFLICT(runner_id) DO UPDATE SET retired_at = COALESCE(claude_runner_cursors.retired_at, excluded.retired_at), attachment_id = '',
				pid = excluded.pid, start_time = excluded.start_time, reaper_pid = excluded.reaper_pid, reaper_start_time = excluded.reaper_start_time,
				session_id = excluded.session_id, driver_kind = excluded.driver_kind,
				member_snapshot = (SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(claude_runner_cursors.member_snapshot) UNION ALL SELECT value FROM json_each(excluded.member_snapshot) WHERE value NOT IN (SELECT value FROM json_each(claude_runner_cursors.member_snapshot))))`.pipe(
						Effect.asVoid,
					),
				),
			appendSignalLog: (
				runnerId: string,
				attempts: readonly RunnerSignalAttempt[],
				signal: RunnerSignal,
			) =>
				flushPendingWrites(
					sql,
					sql`UPDATE claude_runner_cursors SET signal_log = (SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(signal_log) UNION ALL SELECT value FROM json_each(${JSON.stringify(attempts)}))),
				member_snapshot = (SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(member_snapshot) UNION ALL SELECT value FROM json_each(${JSON.stringify(signal.members ?? [])}) WHERE value NOT IN (SELECT value FROM json_each(member_snapshot)))),
				signalled = MAX(signalled, ${signal.tag === "None" ? 0 : 1}), signal_state = ${signal.tag},
				signal_members = ${JSON.stringify(signal.members ?? [])}, signal_sent_members = ${JSON.stringify(signal.tag === "KillSent" ? signal.sent : [])}
				WHERE runner_id = ${runnerId}`.pipe(Effect.asVoid),
				),
			owners: (runnerIds: readonly string[]) =>
				runnerIds.length === 0
					? Effect.succeed({ rows: [], rejected: [] })
					: sql<{
							runner_id: string;
							owned_run_ids: string;
						}>`SELECT runner_id, owned_run_ids
					FROM claude_runner_cursors WHERE runner_id IN ${sql.in(runnerIds)}`.pipe(
							Effect.flatMap((rows) =>
								Effect.partition(rows, (row) =>
									Schema.decodeUnknownEffect(Owned)(row.owned_run_ids).pipe(
										Effect.map((ownedRunIds) => ({
											runnerId: row.runner_id,
											ownedRunIds,
										})),
										Effect.mapError(
											(cause) =>
												new RunnerRetirementDecodeError({
													runnerId: row.runner_id,
													cause,
												}),
										),
										Effect.tapError((error) =>
											Effect.logWarning(
												`Rejected malformed runner ownership: runnerId=${error.runnerId}`,
												error,
											),
										),
									),
								),
							),
							Effect.map(([rows, rejected]) => ({ rows, rejected })),
						),
			retirements: (runnerIds?: readonly string[]) =>
				sql<{
					runner_id: string;
				}>`SELECT runner_id, session_id, role, driver_kind, pid, start_time, owned_run_ids, COALESCE(retired_at, 0) AS retired_at, signalled, retirement_state, signal_state, signal_members, signal_sent_members, reaper_pid, reaper_start_time, member_snapshot, signal_log, stop_state, stop_reason, stop_started_at
					FROM claude_runner_cursors WHERE retired_at IS NOT NULL OR signal_members <> '[]' OR member_snapshot <> '[]'`.pipe(
					Effect.flatMap((rows) =>
						Effect.partition(
							rows.filter(
								(row) => !runnerIds || runnerIds.includes(row.runner_id),
							),
							decodeRetirement,
						),
					),
					Effect.map(([rows, rejected]) => ({ rows, rejected })),
				),
			/** Called in the settlement ingestion transaction, after its projections. */
			settled: (runnerId: string) =>
				sql`UPDATE claude_runner_cursors
				SET owned_run_ids = COALESCE((SELECT json_group_array(value) FROM json_each(owned_run_ids)
					WHERE EXISTS (SELECT 1 FROM provider_runs requested JOIN provider_runs owner
						ON owner.id = COALESCE(requested.joined_into, requested.id) AND owner.session_id = requested.session_id
						WHERE requested.id = value AND requested.session_id = claude_runner_cursors.session_id AND owner.status IN ('pending', 'running')
						AND (owner.runner_id IS NULL OR owner.runner_id = claude_runner_cursors.runner_id))), '[]')
				WHERE runner_id = ${runnerId} AND retired_at IS NOT NULL`.pipe(
					Effect.andThen(
						sql`UPDATE claude_runner_cursors SET retirement_state = CASE WHEN json_array_length(owned_run_ids) = 0 THEN 'Complete' ELSE 'GonePending' END
					WHERE runner_id = ${runnerId} AND retirement_state <> 'Watching'`,
					),
					Effect.asVoid,
				),
			markGone: (runnerId: string) =>
				flushPendingWrites(sql).pipe(
					Effect.andThen(
						flushPendingWrites(
							sql,
							sql`UPDATE claude_runner_cursors SET retirement_state = CASE WHEN json_array_length(owned_run_ids) = 0 THEN 'Complete' ELSE 'GonePending' END
					WHERE runner_id = ${runnerId} AND retired_at IS NOT NULL`.pipe(
								Effect.asVoid,
							),
						),
					),
				),
			pruneRetired: (runnerId: string) =>
				flushPendingWrites(
					sql,
					sql`DELETE FROM claude_runner_cursors WHERE runner_id = ${runnerId} AND retired_at IS NOT NULL
                        AND retirement_state = 'Complete' AND json_array_length(owned_run_ids) = 0
                        AND NOT EXISTS (SELECT 1 FROM provider_runs run WHERE run.session_id = claude_runner_cursors.session_id
                            AND run.runner_id = claude_runner_cursors.runner_id AND run.status IN ('pending', 'running'))`.pipe(
						Effect.asVoid,
					),
				),

			// Atomically claim and read the cursor without masked transaction acquisition.
			attach: (
				runnerId: string,
				attachmentId: string,
				identity?: RunnerCursorIdentity,
			) =>
				sql<{
					sequence: number;
					result_json: string;
				}>`INSERT INTO claude_runner_cursors (runner_id, sequence, attachment_id, session_id, pid, start_time, driver_kind, reaper_pid, reaper_start_time)
					VALUES (${runnerId}, 0, ${attachmentId}, ${identity?.sessionId ?? ""}, ${identity?.pid ?? null}, ${identity?.startTime ?? null}, ${identity?.driverKind ?? "claude"}, ${identity?.reaper?.pid ?? null}, ${identity?.reaper?.startTime ?? null})
					ON CONFLICT(runner_id) DO UPDATE SET attachment_id = excluded.attachment_id,
					session_id = COALESCE(NULLIF(excluded.session_id, ''), claude_runner_cursors.session_id),
					pid = COALESCE(excluded.pid, claude_runner_cursors.pid), start_time = COALESCE(excluded.start_time, claude_runner_cursors.start_time),
					reaper_pid = COALESCE(excluded.reaper_pid, claude_runner_cursors.reaper_pid), reaper_start_time = COALESCE(excluded.reaper_start_time, claude_runner_cursors.reaper_start_time),
					driver_kind = CASE WHEN ${identity?.driverKind !== undefined} THEN excluded.driver_kind ELSE claude_runner_cursors.driver_kind END
					WHERE claude_runner_cursors.retired_at IS NULL
				RETURNING sequence, result_json`.pipe(
					Effect.flatMap((rows) =>
						Schema.decodeUnknownEffect(Reply)(
							rows[0]?.result_json ?? "{}",
						).pipe(
							Effect.map((result) => ({
								sequence: rows[0]?.sequence ?? 0,
								result,
							})),
						),
					),
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
