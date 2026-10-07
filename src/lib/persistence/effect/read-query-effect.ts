import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect, Schema } from "effect";
import {
	LimitRecoverySchema,
	SessionResumeSchema,
} from "../../contracts/limit-recovery.js";
import {
	type SessionGoalChangedPayload,
	SessionGoalChangedPayloadSchema,
} from "../../contracts/stored-event.js";
import type {
	GoalDetails,
	SessionTodos,
	TodoItem,
} from "../../contracts/ws-rpc.js";
import type { SessionBackground } from "../../session/background-liveness.js";
import {
	type SessionAttention,
	type SessionInfo,
	SessionPermissionModeSchema,
} from "../../shared-types.js";
import type {
	MessagePartRow,
	MessageRow,
	MessageWithParts,
	PendingApprovalCountRow,
	PendingApprovalRow,
	PendingClaudeQuestionToolRow,
	SessionRow,
	TurnModelExecutionRow,
} from "../read-model-types.js";
import { sessionFamilyWindowQuery } from "../session-family-query.js";
import {
	messageRowsToHistory,
	toolOutputText,
} from "../session-history-adapter.js";
import { pendingClaudeQuestionToolsQuery } from "../startup-restore-queries.js";

const isSessionPermissionMode = Schema.is(SessionPermissionModeSchema);
const decodeGoalState = Schema.decodeUnknownSync(
	Schema.parseJson(SessionGoalChangedPayloadSchema),
);
const decodeTurnWaits = Schema.decodeUnknownSync(
	Schema.parseJson(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				from: Schema.Number,
				to: Schema.NullOr(Schema.Number),
			}),
		),
	),
);

export const sessionGoalState = (
	row: Pick<SessionRow, "id" | "goal_state">,
): SessionGoalChangedPayload =>
	row.goal_state
		? decodeGoalState(row.goal_state)
		: { sessionId: row.id, goal: null };

/**
 * What `sessionColumns` selects: the single session type with SQLite's NULLs
 * still in place for the two nullable columns.
 */
export const deriveSessionSnooze = (
	row: Pick<
		SessionRow,
		"snoozed_at" | "snoozed_until" | "woken_at" | "woken_reason"
	>,
	now = Date.now(),
): Pick<
	SessionInfo,
	"snoozedAt" | "snoozedUntil" | "wokenAt" | "wokeBecause"
> => {
	if (row.snoozed_at === null) return {};
	const wakeAt =
		row.woken_at ??
		(row.snoozed_until !== null && row.snoozed_until <= now
			? row.snoozed_until
			: null);
	// Woken stays shown until the session is opened, which unsnoozes it; its
	// unread dot is a separate matter (conduit-test-hk9m.9).
	if (wakeAt !== null)
		return { wokenAt: wakeAt, wokeBecause: row.woken_reason ?? "time" };
	return {
		snoozedAt: row.snoozed_at,
		...(row.snoozed_until !== null ? { snoozedUntil: row.snoozed_until } : {}),
	};
};

export const pendingApprovalCountsByType = (
	rows: readonly PendingApprovalCountRow[],
) => {
	const questions = new Map<string, number>();
	const permissions = new Map<string, number>();
	for (const row of rows)
		(row.type === "question" ? questions : permissions).set(
			row.session_id,
			row.pending_count,
		);
	return { questions, permissions };
};

export const sessionRowsToSessionInfoList = (
	rows: readonly SessionRow[],
	opts: {
		readonly now?: number;
		readonly statuses?: Readonly<Record<string, { type: string }>>;
		readonly parentMap?: ReadonlyMap<string, string>;
		readonly sideThreadIds?: ReadonlySet<string>;
		/** Unread descendants, stopping at each Side Thread's edge to its parent. */
		readonly unreadSessionIds?: ReadonlySet<string>;
		readonly pendingQuestionCounts?: ReadonlyMap<string, number>;
		readonly pendingPermissionCounts?: ReadonlyMap<string, number>;
		readonly backgroundOf?: (
			sessionId: string,
		) => SessionBackground | undefined;
	} = {},
): Array<SessionInfo & { readonly updatedAt: number }> => {
	const subtree = new Map<
		string,
		{
			processing: boolean;
			monitoring: boolean;
			unread: boolean;
			questions: number;
			permissions: number;
		}
	>();
	const sideThreadIds = new Set([
		...(opts.sideThreadIds ?? []),
		...rows.flatMap((row) => (row.side_thread === 1 ? [row.id] : [])),
	]);
	const stateFor = (id: string) => {
		const state = subtree.get(id) ?? {
			processing: false,
			monitoring: false,
			unread: false,
			questions: 0,
			permissions: 0,
		};
		subtree.set(id, state);
		return state;
	};
	if (opts.parentMap) {
		const rowStatuses = new Map(rows.map((row) => [row.id, row.status]));
		for (const id of new Set([
			...rowStatuses.keys(),
			...opts.parentMap.keys(),
		])) {
			let root = id;
			let activityRoot: string | undefined;
			const seen = new Set<string>();
			const promptRoots = new Set<string>();
			while (opts.parentMap.has(root) && !seen.has(root)) {
				seen.add(root);
				if (sideThreadIds.has(root)) {
					activityRoot ??= root;
					promptRoots.add(root);
				}
				root = opts.parentMap.get(root) ?? root;
			}
			// Prompts reach each Side Thread ancestor and the family root.
			promptRoots.add(root);
			for (const promptRoot of promptRoots) {
				const state = stateFor(promptRoot);
				state.questions += opts.pendingQuestionCounts?.get(id) ?? 0;
				state.permissions += opts.pendingPermissionCounts?.get(id) ?? 0;
			}
			const activity = stateFor(activityRoot ?? root);
			const status = opts.statuses?.[id]?.type ?? rowStatuses.get(id);
			const work = opts.backgroundOf?.(id)?.work;
			activity.processing ||=
				status === "busy" || status === "retry" || work === "working";
			activity.monitoring ||= work === "monitoring";
			activity.unread ||= opts.unreadSessionIds?.has(id) === true;
		}
	}
	return rows.map((row) => {
		const parentID = row.parent_id ?? undefined;
		const state =
			parentID && row.side_thread !== 1 ? undefined : subtree.get(row.id);
		const pendingQuestionCount =
			state?.questions ?? opts.pendingQuestionCounts?.get(row.id);
		const pendingPermissionCount =
			state?.permissions ?? opts.pendingPermissionCounts?.get(row.id);
		const unread = row.unread === 1;
		const status = opts.statuses?.[row.id]?.type ?? row.status;
		const background = opts.backgroundOf?.(row.id);
		const backgroundWork = background?.work;
		const processing =
			state?.processing ||
			status === "busy" ||
			status === "retry" ||
			backgroundWork === "working";
		const monitoring = state?.monitoring || backgroundWork === "monitoring";
		let attention: SessionAttention = "idle";
		if ((pendingPermissionCount ?? 0) > 0) attention = "needs-approval";
		else if ((pendingQuestionCount ?? 0) > 0) attention = "needs-reply";
		else if (row.last_turn_error_at !== null) attention = "error";
		else if (processing) attention = "working";
		else if (monitoring) attention = "monitoring";
		else if (state?.unread || unread) attention = "done-unread";
		return {
			id: row.id,
			title: row.title,
			status:
				status === "busy" || status === "retry" || status === "error"
					? status
					: "idle",
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			messageCount: 0,
			...(row.goal_state ? { goalState: sessionGoalState(row) } : {}),
			...(isSessionPermissionMode(row.permission_mode)
				? { permissionMode: row.permission_mode }
				: {}),
			...(row.model_id != null && row.model_provider != null
				? { model: { model: row.model_id, provider: row.model_provider } }
				: {}),
			...(row.variant != null ? { variant: row.variant } : {}),
			...(row.context_window != null
				? { contextWindow: row.context_window }
				: {}),
			...(parentID ? { parentID } : {}),
			...(row.side_thread === 1 ? { sideThread: true } : {}),
			...(row.fork_point_event ? { forkMessageId: row.fork_point_event } : {}),
			...(row.fork_point_timestamp != null
				? { forkPointTimestamp: row.fork_point_timestamp }
				: {}),
			...(row.fork_point_message_id != null
				? { forkPointMessageId: row.fork_point_message_id }
				: {}),
			...(processing ? { processing: true } : {}),
			...(backgroundWork ? { backgroundWork } : {}),
			...(background?.tasks.length
				? { backgroundTasks: background.tasks }
				: {}),
			...(pendingQuestionCount ? { pendingQuestionCount } : {}),
			...(pendingPermissionCount ? { pendingPermissionCount } : {}),
			...(unread ? { unread: true } : {}),
			...(row.last_turn_end_version != null
				? { lastTurnEndVersion: row.last_turn_end_version }
				: {}),
			...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
			limitRecovery:
				row.limit_recovery == null
					? null
					: Schema.decodeUnknownSync(Schema.parseJson(LimitRecoverySchema))(
							row.limit_recovery,
						),
			resumes:
				row.resumes == null
					? []
					: Schema.decodeUnknownSync(
							Schema.parseJson(Schema.Array(SessionResumeSchema)),
						)(row.resumes),
			...(row.settled_automatically === 1
				? { settledAutomatically: true }
				: {}),
			...(row.auto_settle_disabled_at != null
				? { autoSettleDisabled: true }
				: {}),
			...(row.pinned_at !== null ? { pinnedAt: row.pinned_at } : {}),
			...deriveSessionSnooze(row, opts.now),
			attention,
		};
	});
};

export class ReadQueryEffectError extends Data.TaggedError(
	"ReadQueryEffectError",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export class TranscriptPageCursorNotFoundError extends Data.TaggedError(
	"TranscriptPageCursorNotFoundError",
)<{
	readonly sessionId: string;
	readonly before: string;
}> {}

interface SessionTranscriptPageOptions {
	readonly before?: string;
	readonly limit: number;
	/** Read from the oldest message, or inclusively from the supplied cursor. */
	readonly forward?: { readonly from?: string };
}

export interface ReadQueryEffect {
	readonly getToolContent: (
		toolId: string,
	) => Effect.Effect<string | undefined, ReadQueryEffectError | SqlError>;

	readonly getSessionStatus: (
		sessionId: string,
	) => Effect.Effect<string | undefined, ReadQueryEffectError | SqlError>;

	readonly getSession: (
		sessionId: string,
	) => Effect.Effect<SessionRow | undefined, ReadQueryEffectError | SqlError>;

	readonly getGoalDetails: (
		sessionId: string,
	) => Effect.Effect<GoalDetails, ReadQueryEffectError | SqlError>;

	readonly getAllSessionStatuses: () => Effect.Effect<
		Record<string, string>,
		ReadQueryEffectError | SqlError
	>;

	readonly getAllSessionStatusesWithProviders: () => Effect.Effect<
		readonly Pick<SessionRow, "id" | "status" | "provider">[],
		ReadQueryEffectError | SqlError
	>;

	readonly getSessionsForReconciliation: (
		reportedIds: readonly string[],
	) => Effect.Effect<
		readonly Pick<SessionRow, "id" | "status" | "updated_at">[],
		ReadQueryEffectError | SqlError
	>;

	readonly listSessions: (opts?: {
		roots?: boolean;
		limit?: number;
		titleQuery?: string;
		before?: { updatedAt: number; id: string };
	}) => Effect.Effect<readonly SessionRow[], ReadQueryEffectError | SqlError>;

	readonly listSessionInfos: (opts?: {
		roots?: boolean;
		limit?: number;
		titleQuery?: string;
		before?: { updatedAt: number; id: string };
		statuses?: Readonly<Record<string, { type: string }>>;
		backgroundOf?: (sessionId: string) => SessionBackground | undefined;
	}) => Effect.Effect<
		readonly (SessionInfo & { readonly updatedAt: number })[],
		ReadQueryEffectError | SqlError
	>;

	readonly getSessionLineage: () => Effect.Effect<
		{
			rows: readonly {
				id: string;
				parent_id: string | null;
				unread: number;
				side_thread: number;
			}[];
			count: number;
		},
		ReadQueryEffectError | SqlError
	>;

	readonly countPendingApprovalsBySession: () => Effect.Effect<
		readonly PendingApprovalCountRow[],
		ReadQueryEffectError | SqlError
	>;
	/**
	 * The approvals subscription's read (ni8.9), in the shape of
	 * {@link readSessionList}. A base read (no `range`) is every pending
	 * approval; a windowed read is every approval that moved inside it,
	 * resolved ones included, because a resolution is a removal to announce.
	 */
	readonly readPendingApprovals: (range?: {
		readonly after?: number;
		readonly through?: number;
	}) => Effect.Effect<
		{ readonly rows: readonly PendingApprovalRow[]; readonly version: number },
		ReadQueryEffectError | SqlError
	>;
	readonly listPendingClaudeQuestionTools?: () => Effect.Effect<
		readonly PendingClaudeQuestionToolRow[],
		ReadQueryEffectError | SqlError
	>;
	readonly getPendingClaudeQuestionTool?: (
		sessionId: string,
		callId: string,
	) => Effect.Effect<
		PendingClaudeQuestionToolRow | undefined,
		ReadQueryEffectError | SqlError
	>;

	readonly getSessionMessagesWithParts: (
		sessionId: string,
	) => Effect.Effect<MessageWithParts[], ReadQueryEffectError | SqlError>;
	readonly getSessionHistoryMetadata: (
		sessionId: string,
	) => Effect.Effect<
		{ readonly messageCount: number; readonly cumulativeTokens: number },
		ReadQueryEffectError | SqlError
	>;
	readonly readSessionTranscriptPage: (
		sessionId: string,
		options: SessionTranscriptPageOptions,
	) => Effect.Effect<
		{
			readonly messages: MessageWithParts[];
			readonly hasMore: boolean;
			readonly version: number;
		},
		ReadQueryEffectError | SqlError | TranscriptPageCursorNotFoundError
	>;

	/**
	 * The session-list rows that moved inside `range`, each with the version it
	 * moved at, and the read-model version the answer is current through.
	 *
	 * `range` omitted is the same read over every version: a cold-start base and
	 * a live window are one query, not two mechanisms that can disagree. Rows
	 * and version are read in ONE transaction, so the version never claims a row
	 * the read could not see.
	 *
	 * `through` is what keeps a slow read honest. Without it the answer is
	 * whatever the read model holds when the query happens to run, which can be
	 * a commit whose advance is still queued — and a subscriber that treats
	 * those rows as seen will then discard that advance, taking its removals
	 * with it. No later query can recover them (§8).
	 */
	readonly readSessionList: (range?: {
		readonly after?: number;
		readonly through?: number;
		readonly roots?: boolean;
		/** Only the family (root and descendants) of this session. */
		readonly familyOf?: string;
		/** In-memory liveness the row cannot carry; see announceBackgroundWork. */
		readonly backgroundOf?: (
			sessionId: string,
		) => SessionBackground | undefined;
	}) => Effect.Effect<
		{
			readonly rows: readonly {
				readonly item: SessionInfo;
				readonly version: number;
			}[];
			readonly version: number;
		},
		ReadQueryEffectError | SqlError
	>;

	/**
	 * As {@link readSessionList}, for one session's projected transcript. A
	 * message part carries no version of its own, so a part write advances the
	 * message that owns it and the whole message comes back. Each row carries
	 * its own `version`.
	 */
	readonly readSessionTranscript: (
		sessionId: string,
		range?: { readonly after?: number; readonly through?: number },
	) => Effect.Effect<
		{
			readonly messages: MessageWithParts[];
			readonly version: number;
			readonly removed?: readonly {
				readonly id: string;
				readonly version: number;
			}[];
		},
		ReadQueryEffectError | SqlError
	>;

	/**
	 * One session's todo list: the items its newest completed TodoWrite left
	 * behind, as one row. Todos are not a table of their own; they are the
	 * TodoWrite tool parts the message projector already keeps, so they inherit
	 * the owning message's version and survive a reload with the transcript.
	 *
	 * A ranged read answers with the row only when a TodoWrite message (or a
	 * removed message) moved inside `range`, at the newest such version, so an
	 * ordinary text delta in the session costs one indexed probe and no row.
	 */
	readonly readSessionTodos: (
		sessionId: string,
		range?: { readonly after?: number; readonly through?: number },
	) => Effect.Effect<
		{
			readonly rows: readonly {
				readonly item: SessionTodos;
				readonly version: number;
			}[];
			readonly version: number;
		},
		ReadQueryEffectError | SqlError
	>;

	readonly getLatestTurnModelExecution: (
		sessionId: string,
	) => Effect.Effect<
		TurnModelExecutionRow | undefined,
		ReadQueryEffectError | SqlError
	>;
}

export class ReadQueryEffectTag extends Context.Tag("ReadQueryEffect")<
	ReadQueryEffectTag,
	ReadQueryEffect
>() {}

type MessageWithTurnModelRow = MessageRow & {
	turn_requested_model: string | null;
	turn_expected_model: string | null;
	turn_actual_model: string | null;
	turn_started_at: number | null;
	turn_completed_at: number | null;
	turn_waits: string;
};

const TODO_STATUSES: readonly TodoItem["status"][] = [
	"pending",
	"in_progress",
	"completed",
	"cancelled",
];

const parseStoredJson = (text: string | null): unknown => {
	if (text === null) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		// A provider's text output is stored as a JSON string, and OpenCode's
		// todowrite output is itself JSON.
		return typeof value === "string" ? parseStoredJson(value) : value;
	} catch {
		return undefined;
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The todo list a TodoWrite carried: its input's `todos` (stored canonically
 * as `{ tool: "Unknown", raw }`), else the list OpenCode echoes as its output.
 * Items speak `content` on the wire and `subject` here. `undefined` when
 * neither side holds a list.
 */
const todoWriteItems = (
	input: string | null,
	result: string | null,
): TodoItem[] | undefined => {
	const listOf = (value: unknown): unknown[] | undefined =>
		Array.isArray(value)
			? value
			: !isRecord(value)
				? undefined
				: Array.isArray(value["todos"])
					? value["todos"]
					: listOf(value["raw"]);
	const list =
		listOf(parseStoredJson(input)) ?? listOf(parseStoredJson(result));
	return list?.filter(isRecord).map((todo, index) => {
		const status = TODO_STATUSES.find((known) => known === todo["status"]);
		const description = todo["description"];
		return {
			id:
				typeof todo["id"] === "string" && todo["id"]
					? todo["id"]
					: `todo-${index}`,
			subject: String(todo["subject"] ?? todo["content"] ?? ""),
			...(typeof description === "string" && description
				? { description }
				: {}),
			status: status ?? "pending",
		};
	});
};

function groupMessagesWithPartsAndTurnModels(
	messages: readonly MessageWithTurnModelRow[],
	parts: readonly MessagePartRow[],
): MessageWithParts[] {
	const partsByMessage = new Map<string, MessagePartRow[]>();
	for (const part of parts) {
		const existing = partsByMessage.get(part.message_id) ?? [];
		existing.push(part);
		partsByMessage.set(part.message_id, existing);
	}
	return messages.map((message) => {
		const {
			turn_requested_model,
			turn_expected_model,
			turn_actual_model,
			turn_started_at,
			turn_completed_at,
			turn_waits,
			...messageRow
		} = message;
		return {
			...messageRow,
			parts: partsByMessage.get(message.id) ?? [],
			...(message.role === "user" && turn_started_at !== null
				? {
						turnTiming: {
							startedAt: turn_started_at,
							...(turn_completed_at === null
								? {}
								: { endedAt: turn_completed_at }),
							waits: decodeTurnWaits(turn_waits).map(({ id, from, to }) => ({
								id,
								from,
								...(to === null ? {} : { to }),
							})),
						},
					}
				: {}),
			...(turn_actual_model === null
				? {}
				: {
						modelExecution: {
							...(turn_requested_model === null
								? {}
								: { requestedModel: turn_requested_model }),
							...(turn_expected_model === null
								? {}
								: { expectedModel: turn_expected_model }),
							actualModel: turn_actual_model,
						},
					}),
		};
	});
}

export const makeReadQueryEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	// A prompt queued behind a running turn starts working when that turn
	// ends, not when it was sent: waiting in the queue is not work.
	const turnTimingColumns = sql`
		MAX(t.requested_at, COALESCE((SELECT MAX(p.completed_at) FROM turns p
			WHERE p.session_id = t.session_id AND p.requested_at < t.requested_at), 0)
		) AS turn_started_at,
		t.completed_at AS turn_completed_at,
		(SELECT json_group_array(json_object(
			'id', pa.id, 'from', pa.created_at, 'to', pa.resolved_at
		))
		FROM (
			SELECT id, created_at, resolved_at FROM pending_approvals
			WHERE session_id = t.session_id
				AND created_at >= t.requested_at
				AND (t.completed_at IS NULL OR created_at <= t.completed_at)
			ORDER BY created_at ASC, id ASC
		) pa) AS turn_waits`;

	const getToolContent = (
		toolId: string,
	): Effect.Effect<string | undefined, ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ content: string }>`
				SELECT content FROM tool_content WHERE tool_id = ${toolId}`;
			if (rows[0]) return rows[0].content;
			// Nothing writes tool_content any more: the part keeps the whole
			// output, and transcripts ship a preview of it.
			const parts = yield* sql<{ result: string }>`
				SELECT result FROM message_parts
				WHERE type = 'tool' AND call_id = ${toolId} AND result IS NOT NULL
				LIMIT 1`;
			return parts[0] && toolOutputText(parts[0].result);
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getToolContent",
							cause: e,
						}),
			),
		);

	const getSessionStatus = (
		sessionId: string,
	): Effect.Effect<string | undefined, ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ status: string }>`
				SELECT status FROM sessions WHERE id = ${sessionId}`;
			return rows[0]?.status;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getSessionStatus",
							cause: e,
						}),
			),
		);

	const getSession = (
		sessionId: string,
	): Effect.Effect<SessionRow | undefined, ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<SessionRow>`
				SELECT * FROM sessions WHERE id = ${sessionId}`;
			return rows[0];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getSession",
							cause: e,
						}),
			),
		);

	const getAllSessionStatusesWithProviders = () =>
		sql<Pick<SessionRow, "id" | "status" | "provider">>`
			SELECT id, status, provider FROM sessions`.pipe(
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({
						operation: "getAllSessionStatusesWithProviders",
						cause,
					}),
			),
		);

	const getAllSessionStatuses = (): Effect.Effect<
		Record<string, string>,
		ReadQueryEffectError | SqlError
	> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ id: string; status: string }>`
				SELECT id, status FROM sessions`;
			const result: Record<string, string> = {};
			for (const row of rows) {
				result[row.id] = row.status;
			}
			return result;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getAllSessionStatuses",
							cause: e,
						}),
			),
		);

	const getSessionsForReconciliation = (reportedIds: readonly string[]) =>
		sql<Pick<SessionRow, "id" | "status" | "updated_at">>`
			SELECT id, status, updated_at FROM sessions
			WHERE status != 'idle'
				OR id IN (SELECT value FROM json_each(${JSON.stringify(reportedIds)}))
			ORDER BY updated_at DESC, id DESC`.pipe(
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({
						operation: "getSessionsForReconciliation",
						cause,
					}),
			),
		);

	// `readSessionList` is the only producer of the single session type (ni8.5
	// T-1) — what the shell subscription streams and what the browser holds.
	// The per-row re-query it replaced is gone: a subscriber asks for what moved
	// past a version, never for one row by id. These column aliases do the
	// renaming,
	// so no caller bridges a row into a session; the only step left in code is
	// NULL-to-absent, which SQL cannot express. `listSessions` stays a row read
	// for the server-internal callers that need columns the wire never carries
	// (the status poller's `updated_at`, permission-mode restore).
	//
	// The last three are the notification facts (ni8.23), derived here so that
	// "does this session want me?" is answered once, by the server, in the same
	// read that produces the row — rather than by each client folding a stream of
	// events into a guess. `pending_approvals` is read-only here: the approval
	// projector owns those rows, and both question and permission requests land
	// in it, so the counts cannot drift from what the app is actually blocked on.
	const listSessions = (opts?: {
		roots?: boolean;
		limit?: number;
		titleQuery?: string;
		before?: { updatedAt: number; id: string };
	}): Effect.Effect<readonly SessionRow[], ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const predicates = [];
			if (opts?.roots) predicates.push(sql`parent_id IS NULL`);
			if (opts?.titleQuery !== undefined) {
				const escapedQuery = opts.titleQuery.replace(/[\\%_]/g, "\\$&");
				const pattern = `%${escapedQuery}%`;
				// SQLite LIKE is ASCII-case-insensitive; we accept non-ASCII case sensitivity until deep search adds a collation.
				predicates.push(sql`title LIKE ${pattern} ESCAPE '\\'`);
			}
			if (opts?.before !== undefined) {
				predicates.push(
					sql`(updated_at < ${opts.before.updatedAt} OR (updated_at = ${opts.before.updatedAt} AND id < ${opts.before.id}))`,
				);
			}
			const limit =
				opts?.limit === undefined ? sql.literal("") : sql`LIMIT ${opts.limit}`;

			// The id DESC tiebreaker makes equal timestamps deterministic. This
			// deliberately replaces the previous arbitrary per-query tie ordering and
			// is required so keyset pages neither duplicate nor skip rows.
			return yield* sql<SessionRow>`
				SELECT * FROM sessions
				WHERE ${sql.and(predicates)}
				ORDER BY updated_at DESC, id DESC
				${limit}`;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "listSessions",
							cause: e,
						}),
			),
		);

	const getSessionLineage = () =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				id: string;
				parent_id: string | null;
				unread: number;
				side_thread: number;
			}>`
				SELECT id, parent_id, unread, side_thread FROM sessions`;
			const counts = yield* sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM sessions`;
			return { rows, count: counts[0]?.count ?? 0 };
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({ operation: "getSessionLineage", cause }),
			),
		);

	const countPendingApprovalsBySession = (): Effect.Effect<
		readonly PendingApprovalCountRow[],
		ReadQueryEffectError | SqlError
	> =>
		Effect.gen(function* () {
			return yield* sql<PendingApprovalCountRow>`
				SELECT session_id, type, COUNT(*) AS pending_count
				FROM pending_approvals
				WHERE status = 'pending'
				GROUP BY session_id, type`;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "countPendingApprovalsBySession",
							cause: e,
						}),
			),
		);

	const listSessionInfos: ReadQueryEffect["listSessionInfos"] = (opts) =>
		Effect.gen(function* () {
			const rows = yield* listSessions(opts);
			// Roll-ups (busy, unread, pending counts) only need the listed rows and
			// their descendants. Reading lineage and status for every session made
			// each page cost a full scan of the store, twice.
			const [family, approvals] = yield* Effect.all([
				sql<{
					id: string;
					parent_id: string | null;
					status: string;
					unread: number;
					side_thread: number;
				}>`
					WITH RECURSIVE family(id) AS (
						SELECT value FROM json_each(${JSON.stringify(rows.map((row) => row.id))})
						UNION
						SELECT child.id FROM sessions child JOIN family ON child.parent_id = family.id
					)
					SELECT id, parent_id, status, unread, side_thread FROM sessions JOIN family USING (id)`,
				countPendingApprovalsBySession(),
			]).pipe(
				Effect.mapError((cause) =>
					cause instanceof ReadQueryEffectError
						? cause
						: new ReadQueryEffectError({
								operation: "listSessionInfos",
								cause,
							}),
				),
			);
			const pending = pendingApprovalCountsByType(approvals);
			return sessionRowsToSessionInfoList(rows, {
				sideThreadIds: new Set(
					family.flatMap((row) => (row.side_thread === 1 ? [row.id] : [])),
				),
				parentMap: new Map(
					family.flatMap((row) =>
						row.parent_id === null ? [] : [[row.id, row.parent_id] as const],
					),
				),
				unreadSessionIds: new Set(
					family.flatMap((row) => (row.unread === 1 ? [row.id] : [])),
				),
				statuses: {
					...Object.fromEntries(
						family.map((row) => [row.id, { type: row.status }]),
					),
					...opts?.statuses,
				},
				pendingQuestionCounts: pending.questions,
				pendingPermissionCounts: pending.permissions,
				...(opts?.backgroundOf && {
					backgroundOf: opts.backgroundOf,
				}),
			});
		});

	const listPendingClaudeQuestionTools = () =>
		sql
			.unsafe<PendingClaudeQuestionToolRow>(pendingClaudeQuestionToolsQuery)
			.pipe(
				Effect.mapError(
					(cause) =>
						new ReadQueryEffectError({
							operation: "listPendingClaudeQuestionTools",
							cause,
						}),
				),
			);

	const getPendingClaudeQuestionTool = (sessionId: string, callId: string) =>
		sql<PendingClaudeQuestionToolRow>`
			SELECT mp.id, mp.call_id, mp.message_id, mp.input, mp.created_at, m.session_id
			FROM message_parts mp
			JOIN messages m ON m.id = mp.message_id
			JOIN sessions s ON s.id = m.session_id
			WHERE s.provider = 'claude' AND m.session_id = ${sessionId}
				AND mp.call_id = ${callId} AND mp.tool_name = 'AskUserQuestion'
				AND mp.status IN ('started', 'running', 'pending')
			LIMIT 1`.pipe(
			Effect.map((rows) => rows[0]),
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({
						operation: "getPendingClaudeQuestionTool",
						cause,
					}),
			),
		);

	const getSessionMessagesWithParts = (
		sessionId: string,
	): Effect.Effect<MessageWithParts[], ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const messages = yield* sql<MessageWithTurnModelRow>`
				SELECT messages.*,
					turns.requested_model AS turn_requested_model,
					turns.expected_model AS turn_expected_model,
					turns.actual_model AS turn_actual_model,
					${turnTimingColumns}
				FROM messages
				LEFT JOIN turns ON turns.id = messages.turn_id
				LEFT JOIN turns t ON t.id = messages.id AND messages.role = 'user'
				WHERE messages.session_id = ${sessionId}
				ORDER BY messages.created_at ASC, messages.id ASC`;
			if (messages.length === 0) return [];

			const parts = yield* sql<MessagePartRow>`
				WITH target_messages AS (
					SELECT id FROM messages
					WHERE session_id = ${sessionId}
					ORDER BY created_at ASC, id ASC
				)
				SELECT mp.* FROM message_parts mp
				JOIN target_messages tm ON mp.message_id = tm.id
				ORDER BY mp.message_id, mp.sort_order`;

			return groupMessagesWithPartsAndTurnModels(messages, parts);
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getSessionMessagesWithParts",
							cause: e,
						}),
			),
		);

	const getSessionHistoryMetadata = (sessionId: string) =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				messageCount: number;
				cumulativeTokens: number;
			}>`
				SELECT COUNT(*) AS messageCount,
					COALESCE(SUM(CASE WHEN rest_payload IS NOT NULL OR tokens_in IS NOT NULL
						OR tokens_out IS NOT NULL OR context_window IS NOT NULL
						THEN COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)
							+ COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_write, 0)
						ELSE 0 END), 0) AS cumulativeTokens
				FROM messages WHERE session_id = ${sessionId}`;
			const metadata = rows[0];
			if (!metadata)
				return yield* new ReadQueryEffectError({
					operation: "getSessionHistoryMetadata",
					cause: new Error("Missing history metadata row"),
				});
			return metadata;
		}).pipe(
			Effect.mapError((cause) =>
				cause instanceof ReadQueryEffectError
					? cause
					: new ReadQueryEffectError({
							operation: "getSessionHistoryMetadata",
							cause,
						}),
			),
		);

	const getGoalDetails = (sessionId: string) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const row = yield* getSession(sessionId);
					const facts = row
						? yield* Effect.try(() => sessionGoalState(row))
						: undefined;
					const goal = facts?.goal ?? facts?.endedGoal;
					if (!goal) return { checks: [], tokensSinceStart: null };

					const checks = yield* sql<GoalDetails["checks"][number]>`
					SELECT iterations AS iteration, created_at AS at, reason
					FROM session_goal_checks
					WHERE session_id = ${sessionId} AND set_at = ${goal.setAt}
					ORDER BY iterations ASC`;
					const rows = yield* getSessionMessagesWithParts(sessionId);
					const history = yield* Effect.try(
						() =>
							messageRowsToHistory(rows, { pageSize: Number.MAX_SAFE_INTEGER })
								.messages,
					);
					return {
						checks,
						tokensSinceStart:
							history.reduce(
								(total, message) =>
									total +
									(message.tokens?.input ?? 0) +
									(message.tokens?.output ?? 0) +
									(message.tokens?.cache?.read ?? 0) +
									(message.tokens?.cache?.write ?? 0),
								0,
							) - goal.tokensAtStart,
					};
				}),
			)
			.pipe(
				Effect.mapError(
					(cause) =>
						new ReadQueryEffectError({ operation: "getGoalDetails", cause }),
				),
			);

	// One query per source serves cold start, resume catch-up and every live
	// advance. `version` is the read-model counter, read FIRST inside the
	// transaction so the rows that follow are from the same consistent state:
	// the number handed to a subscriber never claims a row the read missed.
	//
	// A base read is a catch-up from before the first version. The 0012 backfill
	// left undatable rows at 0, so the floor is -1 rather than 0 — otherwise a
	// cold start would silently skip them.
	const BEFORE_FIRST_VERSION = -1;
	// An unbounded read is bounded by a number the counter cannot reach, which
	// keeps one query shape for both the base and a windowed live read.
	const AFTER_LAST_VERSION = Number.MAX_SAFE_INTEGER;

	const readModelVersion = Effect.gen(function* () {
		const rows = yield* sql<{ value: number }>`
			SELECT value FROM read_model_counter WHERE id = 1`;
		return rows[0]?.value ?? 0;
	});

	const readSessionTranscriptPage = (
		sessionId: string,
		options: SessionTranscriptPageOptions,
	): Effect.Effect<
		{
			readonly messages: MessageWithParts[];
			readonly hasMore: boolean;
			readonly version: number;
		},
		ReadQueryEffectError | SqlError | TranscriptPageCursorNotFoundError
	> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const forward = options.forward !== undefined;
					const cursorId = forward ? options.forward?.from : options.before;
					const cursor =
						cursorId !== undefined
							? (yield* sql<{ created_at: number; id: string }>`
									SELECT created_at, id FROM messages
									WHERE session_id = ${sessionId} AND id = ${cursorId}`)[0]
							: undefined;
					if (cursorId !== undefined && !cursor) {
						return yield* new TranscriptPageCursorNotFoundError({
							sessionId,
							before: cursorId,
						});
					}
					// The first page reaches back to the newest prompt, or further to
					// the prompt still running, which a prompt queued behind it would
					// otherwise push off the page. A turn left running before a later
					// one settled is a crash leftover and is ignored.
					const [anchor] =
						forward || cursor
							? []
							: yield* sql<{ created_at: number; id: string }>`
								SELECT created_at, id FROM messages
								WHERE session_id = ${sessionId} AND role = 'user'
								ORDER BY id IS (
									SELECT id FROM turns
									WHERE session_id = ${sessionId} AND state = 'running'
									AND requested_at >= (SELECT COALESCE(MAX(requested_at), 0) FROM turns
										WHERE session_id = ${sessionId}
										AND state NOT IN ('pending', 'running'))
									ORDER BY requested_at ASC, rowid ASC LIMIT 1
								) DESC, created_at DESC, id DESC
								LIMIT 1`;
					const rows = forward
						? yield* sql<MessageWithTurnModelRow>`
								SELECT messages.*,
									turns.requested_model AS turn_requested_model,
									turns.expected_model AS turn_expected_model,
									turns.actual_model AS turn_actual_model,
									${turnTimingColumns}
								FROM messages
								LEFT JOIN turns ON turns.id = messages.turn_id
								LEFT JOIN turns t ON t.id = messages.id AND messages.role = 'user'
								WHERE messages.session_id = ${sessionId}
									AND (${cursor?.id ?? null} IS NULL
										OR messages.created_at > ${cursor?.created_at ?? null}
										OR (messages.created_at = ${cursor?.created_at ?? null} AND messages.id >= ${cursor?.id ?? null}))
								ORDER BY messages.created_at ASC, messages.id ASC
								LIMIT ${options.limit + 1}`
						: cursor
							? yield* sql<MessageWithTurnModelRow>`
								SELECT messages.*,
									turns.requested_model AS turn_requested_model,
									turns.expected_model AS turn_expected_model,
									turns.actual_model AS turn_actual_model,
									${turnTimingColumns}
								FROM messages
								LEFT JOIN turns ON turns.id = messages.turn_id
								LEFT JOIN turns t ON t.id = messages.id AND messages.role = 'user'
								WHERE messages.session_id = ${sessionId}
									AND (messages.created_at < ${cursor.created_at}
										OR (messages.created_at = ${cursor.created_at} AND messages.id < ${cursor.id}))
								ORDER BY messages.created_at DESC, messages.id DESC
								LIMIT ${options.limit + 1}`
							: yield* sql<MessageWithTurnModelRow>`
								SELECT messages.*,
									turns.requested_model AS turn_requested_model,
									turns.expected_model AS turn_expected_model,
									turns.actual_model AS turn_actual_model,
									${turnTimingColumns}
								FROM messages
								LEFT JOIN turns ON turns.id = messages.turn_id
								LEFT JOIN turns t ON t.id = messages.id AND messages.role = 'user'
								WHERE messages.session_id = ${sessionId}
								ORDER BY messages.created_at DESC, messages.id DESC
								LIMIT (
									SELECT MAX(${options.limit}, COUNT(*)) + 1
									FROM messages m
									WHERE m.session_id = ${sessionId}
										AND (m.created_at > ${anchor?.created_at ?? null}
											OR (m.created_at = ${anchor?.created_at ?? null} AND m.id >= ${anchor?.id ?? null}))
								)`;
					const pageLimit =
						forward || cursor
							? options.limit
							: Math.max(
									options.limit,
									rows.findIndex((message) => message.id === anchor?.id) + 1,
								);
					const page = rows.slice(0, pageLimit);
					if (!forward) page.reverse();
					const parts = page.length
						? yield* sql<MessagePartRow>`
								SELECT * FROM message_parts
								WHERE message_id IN ${sql.in(page.map((message) => message.id))}
								ORDER BY message_id, sort_order`
						: [];
					return {
						messages: groupMessagesWithPartsAndTurnModels(page, parts),
						hasMore: rows.length > pageLimit,
						version,
					};
				}),
			)
			.pipe(
				Effect.mapError((cause) =>
					cause instanceof TranscriptPageCursorNotFoundError
						? cause
						: new ReadQueryEffectError({
								operation: "readSessionTranscriptPage",
								cause,
							}),
				),
			);

	const readSessionList = (range?: {
		readonly after?: number;
		readonly through?: number;
		readonly roots?: boolean;
		readonly familyOf?: string;
		readonly backgroundOf?: (
			sessionId: string,
		) => SessionBackground | undefined;
	}): Effect.Effect<
		{
			readonly rows: readonly {
				readonly item: SessionInfo;
				readonly version: number;
			}[];
			readonly version: number;
		},
		ReadQueryEffectError | SqlError
	> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const floor = range?.after ?? BEFORE_FIRST_VERSION;
					const ceiling = range?.through ?? AFTER_LAST_VERSION;
					const rows: readonly (SessionRow & {
						readonly effective_version?: number;
					})[] =
						range?.familyOf !== undefined
							? yield* sql.unsafe<SessionRow & { effective_version: number }>(
									sessionFamilyWindowQuery,
									[range.familyOf, floor, ceiling],
								)
							: range?.roots
								? yield* sql<SessionRow & { effective_version: number }>`
							WITH RECURSIVE descendants(root_id, id, version) AS (
								SELECT id, id, version FROM sessions WHERE parent_id IS NULL
								UNION ALL
								SELECT d.root_id, child.id, child.version FROM sessions child
								JOIN descendants d ON child.parent_id = d.id
							), roots AS (
								SELECT root_id, MAX(version) AS effective_version FROM descendants GROUP BY root_id
							)
							SELECT sessions.*, roots.effective_version FROM sessions
							JOIN roots ON roots.root_id = sessions.id
							WHERE roots.effective_version > ${floor} AND roots.effective_version <= ${ceiling}
							ORDER BY sessions.updated_at DESC`
								: yield* sql<SessionRow>`
							SELECT * FROM sessions
							WHERE version > ${floor} AND version <= ${ceiling}
							ORDER BY updated_at DESC`;
					const [lineage, approvals, projectedStatuses] = yield* Effect.all([
						getSessionLineage(),
						countPendingApprovalsBySession(),
						getAllSessionStatuses(),
					]);
					const pending = pendingApprovalCountsByType(approvals);
					const items = sessionRowsToSessionInfoList(rows, {
						sideThreadIds: new Set(
							lineage.rows.flatMap((row) =>
								row.side_thread === 1 ? [row.id] : [],
							),
						),
						parentMap: new Map(
							lineage.rows.flatMap((row) =>
								row.parent_id === null
									? []
									: [[row.id, row.parent_id] as const],
							),
						),
						unreadSessionIds: new Set(
							lineage.rows.flatMap((row) => (row.unread === 1 ? [row.id] : [])),
						),
						statuses: Object.fromEntries(
							Object.entries(projectedStatuses).map(([id, type]) => [
								id,
								{ type },
							]),
						),
						pendingQuestionCounts: pending.questions,
						pendingPermissionCounts: pending.permissions,
						...(range?.backgroundOf && {
							backgroundOf: range.backgroundOf,
						}),
					});
					return {
						rows: rows.flatMap((row, index) => {
							const item = items[index];
							if (item === undefined) return [];
							return [
								{
									item,
									version: row.effective_version ?? row.version,
								},
							];
						}),
						version,
					};
				}),
			)
			.pipe(
				Effect.mapError((e) =>
					e instanceof ReadQueryEffectError
						? e
						: new ReadQueryEffectError({
								operation: "readSessionList",
								cause: e,
							}),
				),
			);

	const readPendingApprovals: ReadQueryEffect["readPendingApprovals"] = (
		range,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const floor = range?.after ?? BEFORE_FIRST_VERSION;
					const ceiling = range?.through ?? AFTER_LAST_VERSION;
					const rows =
						range === undefined
							? yield* sql<PendingApprovalRow>`
								SELECT id, session_id, type, status, tool_name, input, details, version
								FROM pending_approvals
								WHERE status = 'pending'
								ORDER BY created_at, id`
							: yield* sql<PendingApprovalRow>`
								SELECT id, session_id, type, status, tool_name, input, details, version
								FROM pending_approvals
								WHERE version > ${floor} AND version <= ${ceiling}
								ORDER BY version, created_at, id`;
					return { rows, version };
				}),
			)
			.pipe(
				Effect.mapError(
					(cause) =>
						new ReadQueryEffectError({
							operation: "readPendingApprovals",
							cause,
						}),
				),
			);

	const readSessionTranscript = (
		sessionId: string,
		range?: { readonly after?: number; readonly through?: number },
	): Effect.Effect<
		{
			readonly messages: MessageWithParts[];
			readonly version: number;
			readonly removed?: readonly {
				readonly id: string;
				readonly version: number;
			}[];
		},
		ReadQueryEffectError | SqlError
	> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const floor = range?.after ?? BEFORE_FIRST_VERSION;
					const ceiling = range?.through ?? AFTER_LAST_VERSION;
					const messages = yield* sql<MessageWithTurnModelRow>`
						SELECT messages.*,
							turns.requested_model AS turn_requested_model,
							turns.expected_model AS turn_expected_model,
							turns.actual_model AS turn_actual_model,
							${turnTimingColumns}
						FROM messages
						LEFT JOIN turns ON turns.id = messages.turn_id
						LEFT JOIN turns t ON t.id = messages.id AND messages.role = 'user'
						WHERE messages.session_id = ${sessionId}
							AND messages.version > ${floor} AND messages.version <= ${ceiling}
						ORDER BY messages.created_at ASC, messages.id ASC`;

					let parts: readonly MessagePartRow[] = [];
					if (messages.length > 0) {
						parts = yield* sql<MessagePartRow>`
							WITH target_messages AS (
								SELECT id FROM messages
								WHERE session_id = ${sessionId}
									AND version > ${floor} AND version <= ${ceiling}
							)
							SELECT mp.* FROM message_parts mp
							JOIN target_messages tm ON mp.message_id = tm.id
							ORDER BY mp.message_id, mp.sort_order`;
					}
					const removed =
						range === undefined
							? undefined
							: yield* sql<{
									id: string;
									version: number;
								}>`SELECT message_id AS id, version FROM message_tombstones
						WHERE session_id = ${sessionId}
						AND version > ${floor} AND version <= ${ceiling}
						ORDER BY version, message_id`;

					return {
						messages: groupMessagesWithPartsAndTurnModels(messages, parts),
						version,
						...(removed === undefined ? {} : { removed }),
					};
				}),
			)
			.pipe(
				Effect.mapError((e) =>
					e instanceof ReadQueryEffectError
						? e
						: new ReadQueryEffectError({
								operation: "readSessionTranscript",
								cause: e,
							}),
				),
			);

	const readSessionTodos = (
		sessionId: string,
		range?: { readonly after?: number; readonly through?: number },
	): Effect.Effect<
		{
			readonly rows: readonly {
				readonly item: SessionTodos;
				readonly version: number;
			}[];
			readonly version: number;
		},
		ReadQueryEffectError | SqlError
	> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const floor = range?.after ?? BEFORE_FIRST_VERSION;
					const ceiling = range?.through ?? AFTER_LAST_VERSION;
					const moved =
						range === undefined
							? undefined
							: ((yield* sql<{ moved: number | null }>`
						SELECT MAX(v) AS moved FROM (
							SELECT messages.version AS v FROM messages
							JOIN message_parts mp ON mp.message_id = messages.id
							WHERE messages.session_id = ${sessionId}
								AND messages.version > ${floor} AND messages.version <= ${ceiling}
								AND mp.tool_name = 'TodoWrite'
							UNION ALL
							SELECT version AS v FROM message_tombstones
							WHERE session_id = ${sessionId}
								AND version > ${floor} AND version <= ${ceiling}
						)`)[0]?.moved ?? null);
					if (moved === null) return { rows: [], version };
					// The newest few writes are plenty: the first one that still
					// parses is the list, and older ones are history.
					const writes = yield* sql<{
						input: string | null;
						result: string | null;
						version: number;
					}>`
						SELECT mp.input, mp.result, messages.version
						FROM message_parts mp
						JOIN messages ON messages.id = mp.message_id
						WHERE messages.session_id = ${sessionId}
							AND messages.version <= ${ceiling}
							AND mp.tool_name = 'TodoWrite' AND mp.status = 'completed'
						ORDER BY messages.created_at DESC, messages.id DESC, mp.sort_order DESC
						LIMIT 10`;
					const items =
						writes
							.map((write) => todoWriteItems(write.input, write.result))
							.find((parsed) => parsed !== undefined) ?? [];
					return {
						rows: [
							{
								item: { sessionId, items },
								version: moved ?? writes[0]?.version ?? 0,
							},
						],
						version,
					};
				}),
			)
			.pipe(
				Effect.mapError((e) =>
					e instanceof ReadQueryEffectError
						? e
						: new ReadQueryEffectError({
								operation: "readSessionTodos",
								cause: e,
							}),
				),
			);

	const getLatestTurnModelExecution = (
		sessionId: string,
	): Effect.Effect<
		TurnModelExecutionRow | undefined,
		ReadQueryEffectError | SqlError
	> =>
		Effect.gen(function* () {
			const rows = yield* sql<TurnModelExecutionRow>`
				SELECT requested_model, expected_model, actual_model
				FROM turns
				WHERE session_id = ${sessionId}
					AND actual_model IS NOT NULL
				ORDER BY requested_at DESC
				LIMIT 1`;
			return rows[0];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getLatestTurnModelExecution",
							cause: e,
						}),
			),
		);

	return {
		getToolContent,
		getSessionStatus,
		getSession,
		getGoalDetails,
		getAllSessionStatuses,
		getAllSessionStatusesWithProviders,
		listSessions,
		listSessionInfos,
		getSessionLineage,
		getSessionsForReconciliation,
		countPendingApprovalsBySession,
		readPendingApprovals,
		listPendingClaudeQuestionTools,
		getPendingClaudeQuestionTool,
		getSessionMessagesWithParts,
		getSessionHistoryMetadata,
		readSessionTranscriptPage,
		readSessionList,
		readSessionTranscript,
		readSessionTodos,
		getLatestTurnModelExecution,
	} satisfies ReadQueryEffect;
});
