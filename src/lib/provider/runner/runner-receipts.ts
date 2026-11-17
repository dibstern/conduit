import { Clock, Context, Data, type Deferred, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import {
	appendUnprojected,
	flushPendingWrites,
} from "../../persistence/effect/commit-and-signal.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../persistence/events.js";
import type { PermissionResponse } from "../types.js";
import {
	ProcessMember,
	ProcessStart,
	StartTime,
	sameProcess,
} from "./process-identity.js";
import { legacyRunnerRanking } from "./runner-registry.js";
import { type StoreFault, toStoreFault } from "./send-settlement.js";
import type { SessionOutputReply } from "./session-runner.js";

export type RunnerRole = "serving" | "candidate";
export type StopReason =
	| {
			readonly _tag:
				| "Explicit"
				| "ProjectRemoved"
				| "Idle"
				| "Exited"
				| "CandidateAbandoned";
	  }
	// A restart's orphan ends the native session too, but no user asked (6.3).
	| { readonly _tag: "EndSession"; readonly orphan?: true }
	| {
			readonly _tag: "Superseded";
			readonly successor: string;
			/** The successor's hello querySeq, its process_started label (6.1). */
			readonly successorQuerySeq?: number;
	  };
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

const Member = ProcessMember;
const Members = Schema.fromJsonString(Schema.Array(Member));
export type RunnerMember = typeof Member.Encoded;
const SignalAttempt = Schema.Struct({
	signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
	/** Older logs predate a grace clock anchored to the actual TERM attempt. */
	at: Schema.optionalKey(Schema.Number),
	target: Schema.Number.check(Schema.isInt()),
	members: Schema.Array(Member),
	outcome: Schema.Literals(["delivered", "refused", "failed"]),
});
export type RunnerSignalAttempt = typeof SignalAttempt.Encoded;
export type RunnerProcessIdentity =
	| ({
			readonly tag: "Verified";
			readonly pid: number;
	  } & typeof ProcessStart.Encoded)
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
export type RunnerSignal = typeof Signal.Encoded;
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
	start_time: Schema.NullOr(ProcessStart.fields.startTime),
	start_key: Schema.NullOr(Schema.String),
	retired_at: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0),
	),
	signalled: Schema.Literals([0, 1]),
	retirement_state: Schema.Literals(["Watching", "Complete"]),
	signal_state: Schema.Literals(["None", "TermSent", "KillSent"]),
	signal_members: Members,
	signal_sent_members: Members,
	reaper_pid: Schema.NullOr(Member.fields.pid),
	reaper_start_time: Schema.NullOr(ProcessStart.fields.startTime),
	reaper_start_key: Schema.NullOr(Schema.String),
	member_snapshot: Members,
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

// Keep nullable additions outside the migration ledger so older daemons can
// reopen the store. Imports normalize private copies through this same owner.
export const ensureRunnerStartColumns = (sql: SqlClient.SqlClient) =>
	Effect.gen(function* () {
		const columns = yield* sql<{
			name: string;
		}>`PRAGMA table_info(claude_runner_cursors)`;
		for (const name of ["start_key", "reaper_start_key"])
			if (!columns.some((column) => column.name === name))
				yield* sql.unsafe(
					`ALTER TABLE claude_runner_cursors ADD COLUMN ${name} TEXT`,
				);
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
		| { readonly tag: "Complete" };
	readonly signal: RunnerSignal;
	readonly reaper: RunnerMember | undefined;
	readonly members: readonly RunnerMember[];
	readonly signalLog: readonly RunnerSignalAttempt[];
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

/** What a Stop names; its committing transaction supplies everything else. */
export type StopTarget = Pick<
	RunnerRetirement,
	"runnerId" | "sessionId" | "driverKind" | "identity" | "reaper" | "members"
>;

export type StopCommit =
	| {
			readonly _tag: "Requested";
			readonly record: RunnerRetirement;
			readonly candidates: readonly RunnerRetirement[];
			/** The session's rows as the committing transaction left them. */
			readonly session: readonly RunnerRow[];
			/**
			 * The loss of each runner this commit first retired (6.5), then a swap's
			 * successor start (6.9). Its caller appends them in the same transaction,
			 * after any releases it makes.
			 */
			readonly evidence: readonly CanonicalEvent[];
	  }
	| { readonly _tag: "Ignored" };

export const stopRecord = (
	target: StopTarget,
	retiredAt: number,
): RunnerRetirement => ({
	runnerId: target.runnerId,
	sessionId: target.sessionId,
	driverKind: target.driverKind,
	identity: target.identity,
	reaper: target.reaper,
	members: target.members,
	signalLog: [],
	signal: { tag: "None" },
	retirement: { tag: "Watching" },
	retiredAt,
});

// The string and key cross the SQL boundary together, including legacy NULL keys.
const processStartRow = {
	encode: (
		start: Pick<RunnerCursorIdentity, "startTime" | "startKey"> | undefined,
	) => ({
		time: start?.startTime ?? null,
		key: start?.startTime === undefined ? null : (start.startKey ?? null),
	}),
	decode: (time: string | null, key: string | null) =>
		time === null
			? undefined
			: { startTime: time, ...(key === null ? {} : { startKey: key }) },
};

const decodeRetirement = (raw: { readonly runner_id: string }) =>
	Effect.gen(function* () {
		const row = yield* Schema.decodeUnknownEffect(RetirementRow)(raw);
		if (
			(row.pid === null && row.start_time !== null) ||
			(row.reaper_pid === null) !== (row.reaper_start_time === null)
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
		const start = processStartRow.decode(row.start_time, row.start_key);
		const reaperStart = processStartRow.decode(
			row.reaper_start_time,
			row.reaper_start_key,
		);
		const leader =
			row.pid !== null && start ? { pid: row.pid, ...start } : undefined;
		const reaper =
			row.reaper_pid !== null && reaperStart
				? { pid: row.reaper_pid, ...reaperStart }
				: undefined;
		return {
			runnerId: row.runner_id,
			sessionId: row.session_id,
			driverKind: row.driver_kind,
			identity: leader
				? { tag: "Verified", ...leader }
				: {
						tag: "Unverifiable",
						...(row.pid === null ? {} : { pid: row.pid }),
					},
			retirement: { tag: row.retirement_state },
			signal,
			reaper,
			members: mergeRunnerMembers(
				row.member_snapshot,
				row.signal_members,
				leader ? [leader] : [],
				reaper ? [reaper] : [],
			),
			signalLog: row.signal_log,
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
) => {
	const members: RunnerMember[] = [];
	for (const snapshot of snapshots)
		for (const member of snapshot) {
			const index = members.findIndex(
				(saved) =>
					saved.pid === member.pid &&
					sameProcess(saved, {
						state: "running",
						...member,
						startTime: StartTime.make(member.startTime),
					}) === "same",
			);
			if (index === -1) members.push(member);
			else if (
				member.startKey !== undefined ||
				members[index]?.startKey === undefined
			)
				members[index] = member;
		}
	return members;
};

export interface RunnerCursorIdentity
	extends Partial<{
		[Key in keyof typeof ProcessStart.Encoded]:
			| (typeof ProcessStart.Encoded)[Key]
			| undefined;
	}> {
	readonly sessionId: string;
	readonly driverKind?: string | undefined;
	readonly pid?: number | undefined;
	readonly reaper?: RunnerMember | undefined;
	/** Recorded at hello; see journalsBeforeExecution. */
	readonly journalsBeforeExecution?: boolean | undefined;
}

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
		yield* flushPendingWrites(
			sql,
			Effect.gen(function* () {
				yield* ensureRunnerStartColumns(sql);
				const slotIndex =
					yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_runner_serving_session'`;
				if (slotIndex.length === 0) {
					// Legacy-only role ranking. Delete with 32.13 after retained rows migrate.
					const configDir = options.configDir;
					const registry: ReturnType<typeof legacyRunnerRanking> = configDir
						? yield* Effect.sync(() => legacyRunnerRanking(configDir))
						: new Map();
					// main's rows have no session_id; its registration names the session (S9.6).
					for (const [runnerId, { sessionId }] of registry)
						if (sessionId)
							yield* sql`UPDATE claude_runner_cursors SET session_id = ${sessionId} WHERE runner_id = ${runnerId} AND session_id = ''`;
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
		const saveStop = (record: RunnerRetirement, reason: StopReason) => {
			const start = processStartRow.encode(
				record.identity.tag === "Verified" ? record.identity : undefined,
			);
			const reaper = processStartRow.encode(record.reaper);
			return sql`INSERT INTO claude_runner_cursors (runner_id, sequence, attachment_id, session_id, driver_kind, retired_at, pid, start_time, start_key, reaper_pid, reaper_start_time, reaper_start_key, member_snapshot, stop_reason)
				VALUES (${record.runnerId}, 0, '', ${record.sessionId}, ${record.driverKind}, ${record.retiredAt}, ${record.identity.pid ?? null}, ${start.time}, ${start.key}, ${record.reaper?.pid ?? null}, ${reaper.time}, ${reaper.key}, '[]', ${JSON.stringify(reason)})
				ON CONFLICT(runner_id) DO UPDATE SET retired_at = excluded.retired_at, attachment_id = '', session_id = excluded.session_id, driver_kind = excluded.driver_kind, pid = excluded.pid, start_time = excluded.start_time, start_key = excluded.start_key, reaper_pid = excluded.reaper_pid, reaper_start_time = excluded.reaper_start_time, reaper_start_key = excluded.reaper_start_key, stop_state = 'Requested', stop_reason = excluded.stop_reason`.pipe(
				Effect.asVoid,
			);
		};
		// The one reader of 6.5's loss: for runners the caller's write first retired,
		// none for a runner whose session row is gone or has no project.
		const processLost = (runnerIds: readonly string[]) =>
			sql<{
				session_id: string;
				runner_id: string;
				retired_at: number;
				provider: string;
			}>`SELECT runner.session_id, runner.runner_id, runner.retired_at, session.provider
				FROM claude_runner_cursors runner JOIN sessions session ON session.id = runner.session_id
				WHERE runner.runner_id IN ${sql.in(runnerIds)} AND runner.retired_at IS NOT NULL
				AND COALESCE(session.project_id, '') <> '' ORDER BY runner.rowid`.pipe(
				Effect.map((rows) =>
					rows.map((row) =>
						canonicalEvent(
							"evidence.process_lost",
							row.session_id,
							{ runnerId: row.runner_id, retiredAt: row.retired_at },
							{ provider: row.provider, createdAt: row.retired_at },
						),
					),
				),
			);
		// 6.1: a serving runner's start, labelled with its hello's querySeq, for a
		// live runner whose session has a project, as processLost reads its loss.
		// `unreported` keeps only a runner with no start yet: a draft pre-warm's, whose
		// hello came before CreateSession stored its session.
		const processStarted = (
			runnerId: string,
			querySeq: number,
			reattached: boolean,
			unreported = false,
		) =>
			sql<{
				session_id: string;
				provider: string;
			}>`SELECT runner.session_id, session.provider
				FROM claude_runner_cursors runner JOIN sessions session ON session.id = runner.session_id
				WHERE runner.runner_id = ${runnerId} AND runner.retired_at IS NULL
				AND COALESCE(session.project_id, '') <> ''
				AND (${unreported ? 0 : 1} OR NOT EXISTS (SELECT 1 FROM events event
					WHERE event.session_id = runner.session_id AND event.type = 'evidence.process_started'
					AND json_extract(event.data, '$.runnerId') = runner.runner_id))`.pipe(
				Effect.map((rows) =>
					rows.map((row) =>
						canonicalEvent(
							"evidence.process_started",
							row.session_id,
							{ runnerId, label: `${runnerId}:${querySeq}`, reattached },
							{ provider: row.provider },
						),
					),
				),
			);
		const runners = (sessionId?: string) =>
			sql<{
				runner_id: string;
				role: string;
				retired_at: number | null;
				sequence: number;
			}>`SELECT * FROM claude_runner_cursors WHERE ${sessionId === undefined ? sql`1 = 1` : sql`session_id = ${sessionId}`} ORDER BY rowid`.pipe(
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
			);
		/**
		 * Runs inside the caller's write; it never acquires a second writer.
		 * Role, successor and candidates are read here, so the in-memory
		 * registry never decides who serves.
		 */
		const requestStopMutation = (
			target: StopTarget,
			reason: StopReason = { _tag: "Explicit" },
		) =>
			Effect.gen(function* () {
				const retiredAt = yield* Clock.currentTimeMillis;
				const [existingRaw] = yield* rawRunner(target.runnerId);
				const [fence] = yield* sql<{
					retired_at: number | null;
					role: RunnerRole;
					session_id: string;
				}>`SELECT retired_at, role, session_id FROM claude_runner_cursors WHERE runner_id = ${target.runnerId}`;
				const existing = existingRaw
					? yield* decodeRetirement(existingRaw)
					: undefined;
				if (existing) {
					if (fence?.session_id !== target.sessionId)
						return yield* new RunnerSlotError({
							runnerId: target.runnerId,
							cause: "Runner session changed",
						});
					if (fence.retired_at !== null) {
						if (reason._tag === "Superseded") {
							const successor =
								yield* sql`SELECT 1 FROM claude_runner_cursors WHERE runner_id = ${reason.successor} AND session_id = ${target.sessionId} AND retired_at IS NULL AND role = 'serving'`;
							if (
								existing.stopReason !== JSON.stringify(reason) ||
								successor.length === 0
							)
								return yield* new RunnerSlotError({
									runnerId: target.runnerId,
									cause: "A different Stop won the swap",
								});
						}
						return {
							_tag: "Requested",
							record: existing,
							candidates: [],
							session: (yield* runners(target.sessionId)).rows,
							evidence: [],
						} satisfies StopCommit;
					}
					// An abandoned candidate that was promoted keeps serving.
					if (reason._tag === "CandidateAbandoned" && fence.role === "serving")
						return { _tag: "Ignored" } satisfies StopCommit;
				}
				const candidates: RunnerRetirement[] = [];
				if (reason._tag === "Superseded") {
					const [successor] = yield* sql<{
						runner_id: string;
					}>`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${reason.successor} AND session_id = ${target.sessionId} AND retired_at IS NULL AND role = 'candidate'`;
					const held =
						yield* sql`SELECT 1 FROM provider_runs WHERE runner_id = ${target.runnerId} AND status IN ('pending', 'running') LIMIT 1`;
					if (
						!fence ||
						fence.role !== "serving" ||
						!successor ||
						held.length > 0
					)
						return yield* new RunnerSlotError({
							runnerId: target.runnerId,
							cause: "Runner swap refused",
						});
					const [rawSuccessor] = yield* rawRunner(reason.successor);
					if (rawSuccessor) yield* decodeRetirement(rawSuccessor);
				} else if (fence?.role === "serving") {
					const live = yield* sql<{
						runner_id: string;
					}>`SELECT *, COALESCE(retired_at, 0) AS retired_at FROM claude_runner_cursors WHERE session_id = ${target.sessionId} AND role = 'candidate' AND retired_at IS NULL ORDER BY rowid`;
					for (const raw of live) {
						yield* saveStop(
							stopRecord(yield* decodeRetirement(raw), retiredAt),
							{ _tag: "CandidateAbandoned" },
						);
						const [saved] = yield* rawRunner(raw.runner_id);
						if (saved) candidates.push(yield* decodeRetirement(saved));
					}
				}
				// The row owns identity; the hello can supply a reaper not yet stored.
				// Only the watcher's kill pass may grow membership.
				const record = stopRecord(
					existing
						? { ...existing, reaper: existing.reaper ?? target.reaper }
						: { ...target, members: [] },
					retiredAt,
				);
				yield* saveStop(record, reason);
				if (reason._tag === "Superseded")
					yield* sql`UPDATE claude_runner_cursors SET role = 'serving' WHERE runner_id = ${reason.successor}`;
				const [saved] = yield* rawRunner(target.runnerId);
				return {
					_tag: "Requested",
					record: saved ? yield* decodeRetirement(saved) : record,
					candidates,
					session: (yield* runners(target.sessionId)).rows,
					evidence: [
						...(yield* processLost([
							target.runnerId,
							...candidates.map((candidate) => candidate.runnerId),
						])),
						...(reason._tag === "Superseded"
							? yield* processStarted(
									reason.successor,
									reason.successorQuerySeq ?? 0,
									false,
								)
							: []),
					],
				} satisfies StopCommit;
			});
		return {
			read,
			processStarted,
			register: (
				runnerId: string,
				identity: RunnerCursorIdentity,
				role: RunnerRole,
			): Effect.Effect<"Registered" | "Lost", StoreFault> =>
				Effect.gen(function* () {
					const start = processStartRow.encode(identity);
					const reaper = processStartRow.encode(identity.reaper);
					let result: "Registered" | "Lost" = "Lost";
					yield* flushPendingWrites(
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
								if (serving.length === 0) return "Lost" as const;
							} else {
								const occupied = yield* sql`SELECT 1 FROM claude_runner_cursors
								WHERE session_id = ${identity.sessionId} AND retired_at IS NULL LIMIT 1`;
								if (occupied.length > 0) return "Lost" as const;
							}
							yield* sql`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, driver_kind, pid, start_time, start_key, reaper_pid, reaper_start_time, reaper_start_key, role)
					VALUES (${runnerId}, 0, ${identity.sessionId}, ${identity.driverKind ?? "claude"}, ${identity.pid ?? null}, ${start.time}, ${start.key}, ${identity.reaper?.pid ?? null}, ${reaper.time}, ${reaper.key}, ${role})`;
							const [saved] = yield* rawRunner(runnerId);
							if (saved) yield* decodeRetirement(saved);
							return "Registered" as const;
						}).pipe(
							Effect.tap((registered) =>
								Effect.sync(() => {
									result = registered;
								}),
							),
							Effect.asVoid,
						),
					);
					return result;
				}).pipe(Effect.mapError(toStoreFault)),
			runners,
			/** Retirement and slot promotion share dispatch's writer lock. */
			requestStopMutation,
			requestStop: (
				target: StopTarget,
				reason: StopReason = { _tag: "Explicit" },
			) =>
				Effect.gen(function* () {
					let committed = { _tag: "Ignored" } as StopCommit;
					yield* flushPendingWrites(
						sql,
						requestStopMutation(target, reason).pipe(
							Effect.tap((saved) =>
								Effect.sync(() => {
									committed = saved;
								}),
							),
							Effect.tap((saved) =>
								saved._tag === "Requested"
									? appendUnprojected(sql, saved.evidence)
									: Effect.void,
							),
						),
					);
					return committed;
				}),
			stopProgress: (record: RunnerRetirement) =>
				flushPendingWrites(
					sql,
					sql`UPDATE claude_runner_cursors SET stop_state = ${record.stopState ?? "Requested"}, stop_started_at = ${record.stopStartedAt ?? null},
					retirement_state = CASE WHEN ${record.stopState === "Gone" || record.stopState === "Settled"} THEN 'Complete' ELSE retirement_state END
					WHERE runner_id = ${record.runnerId} AND retired_at IS NOT NULL`.pipe(
						Effect.asVoid,
					),
				),
			commitRetirement: (record: RunnerRetirement) =>
				flushPendingWrites(
					sql,
					Effect.gen(function* () {
						const start = processStartRow.encode(
							record.identity.tag === "Verified" ? record.identity : undefined,
						);
						const reaper = processStartRow.encode(record.reaper);
						const [before] = yield* sql<{
							retired_at: number | null;
							member_snapshot: string;
						}>`SELECT retired_at, member_snapshot FROM claude_runner_cursors WHERE runner_id = ${record.runnerId}`;
						const members = mergeRunnerMembers(
							yield* Schema.decodeUnknownEffect(Members)(
								before?.member_snapshot ?? "[]",
							),
							record.members,
						);
						yield* sql`INSERT INTO claude_runner_cursors (runner_id, sequence, attachment_id, session_id, driver_kind, retired_at, pid, start_time, start_key, reaper_pid, reaper_start_time, reaper_start_key, member_snapshot)
				VALUES (${record.runnerId}, 0, '', ${record.sessionId}, ${record.driverKind}, ${record.retiredAt}, ${record.identity.pid ?? null}, ${start.time}, ${start.key}, ${record.reaper?.pid ?? null}, ${reaper.time}, ${reaper.key}, ${JSON.stringify(members)})
				ON CONFLICT(runner_id) DO UPDATE SET retired_at = COALESCE(claude_runner_cursors.retired_at, excluded.retired_at), attachment_id = '',
				pid = excluded.pid, start_time = excluded.start_time, start_key = excluded.start_key, reaper_pid = excluded.reaper_pid, reaper_start_time = excluded.reaper_start_time, reaper_start_key = excluded.reaper_start_key,
				session_id = excluded.session_id, driver_kind = excluded.driver_kind,
				member_snapshot = excluded.member_snapshot`;
						if (before?.retired_at == null)
							yield* appendUnprojected(
								sql,
								yield* processLost([record.runnerId]),
							);
					}),
				),
			appendSignalLog: (
				runnerId: string,
				attempts: readonly RunnerSignalAttempt[],
				signal: RunnerSignal,
			) =>
				flushPendingWrites(
					sql,
					Effect.gen(function* () {
						const [before] = yield* sql<{
							member_snapshot: string;
						}>`SELECT member_snapshot FROM claude_runner_cursors WHERE runner_id = ${runnerId}`;
						const members = mergeRunnerMembers(
							yield* Schema.decodeUnknownEffect(Members)(
								before?.member_snapshot ?? "[]",
							),
							signal.members ?? [],
						);
						yield* sql`UPDATE claude_runner_cursors SET signal_log = (SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(signal_log) UNION ALL SELECT value FROM json_each(${JSON.stringify(attempts)}))),
				member_snapshot = ${JSON.stringify(members)},
				signalled = MAX(signalled, ${signal.tag === "None" ? 0 : 1}), signal_state = ${signal.tag},
				signal_members = ${JSON.stringify(signal.members ?? [])}, signal_sent_members = ${JSON.stringify(signal.tag === "KillSent" ? signal.sent : [])}
				WHERE runner_id = ${runnerId}`;
					}),
				),
			retirements: (runnerIds?: readonly string[]) =>
				sql<{
					runner_id: string;
				}>`SELECT runner_id, session_id, role, driver_kind, pid, start_time, start_key, COALESCE(retired_at, 0) AS retired_at, signalled, retirement_state, signal_state, signal_members, signal_sent_members, reaper_pid, reaper_start_time, reaper_start_key, member_snapshot, signal_log, stop_state, stop_reason, stop_started_at
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
			markGone: (runnerId: string) =>
				flushPendingWrites(sql).pipe(
					Effect.andThen(
						flushPendingWrites(
							sql,
							sql`UPDATE claude_runner_cursors SET retirement_state = 'Complete'
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
                        AND retirement_state = 'Complete'
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
			) => {
				const start = processStartRow.encode(identity);
				const reaper = processStartRow.encode(identity?.reaper);
				return sql<{
					sequence: number;
					result_json: string;
				}>`INSERT INTO claude_runner_cursors (runner_id, sequence, attachment_id, session_id, pid, start_time, start_key, driver_kind, reaper_pid, reaper_start_time, reaper_start_key, journals_before_execution)
					VALUES (${runnerId}, 0, ${attachmentId}, ${identity?.sessionId ?? ""}, ${identity?.pid ?? null}, ${start.time}, ${start.key}, ${identity?.driverKind ?? "claude"}, ${identity?.reaper?.pid ?? null}, ${reaper.time}, ${reaper.key}, ${identity?.journalsBeforeExecution === undefined ? null : Number(identity.journalsBeforeExecution)})
					ON CONFLICT(runner_id) DO UPDATE SET attachment_id = excluded.attachment_id,
					session_id = COALESCE(NULLIF(excluded.session_id, ''), claude_runner_cursors.session_id),
					pid = COALESCE(excluded.pid, claude_runner_cursors.pid), start_time = COALESCE(excluded.start_time, claude_runner_cursors.start_time),
					start_key = CASE WHEN excluded.start_time IS NULL THEN claude_runner_cursors.start_key ELSE excluded.start_key END,
					reaper_pid = COALESCE(excluded.reaper_pid, claude_runner_cursors.reaper_pid), reaper_start_time = COALESCE(excluded.reaper_start_time, claude_runner_cursors.reaper_start_time),
					reaper_start_key = CASE WHEN excluded.reaper_start_time IS NULL THEN claude_runner_cursors.reaper_start_key ELSE excluded.reaper_start_key END,
					journals_before_execution = COALESCE(excluded.journals_before_execution, claude_runner_cursors.journals_before_execution),
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
				);
			},
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
