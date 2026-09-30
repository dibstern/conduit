import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";
import type { SessionAttention, SessionInfo } from "../../shared-types.js";
import type {
	MessagePartRow,
	MessageRow,
	MessageWithParts,
	PendingApprovalCountRow,
	PendingClaudeQuestionToolRow,
	SessionRow,
	TurnModelExecutionRow,
} from "../read-model-types.js";
import { sessionFamilyQuery } from "../session-family-query.js";

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
		/** Unread sessions anywhere in the lineage; a root's dot rolls up its forks. */
		readonly unreadSessionIds?: ReadonlySet<string>;
		readonly pendingQuestionCounts?: ReadonlyMap<string, number>;
		readonly pendingPermissionCounts?: ReadonlyMap<string, number>;
		readonly hasLiveBackgroundWork?: (sessionId: string) => boolean;
	} = {},
): Array<SessionInfo & { readonly updatedAt: number }> => {
	const subtree = new Map<
		string,
		{
			processing: boolean;
			unread: boolean;
			questions: number;
			permissions: number;
		}
	>();
	if (opts.parentMap) {
		const rowStatuses = new Map(rows.map((row) => [row.id, row.status]));
		for (const id of new Set([
			...rowStatuses.keys(),
			...opts.parentMap.keys(),
		])) {
			let root = id;
			const seen = new Set<string>();
			while (opts.parentMap.has(root) && !seen.has(root)) {
				seen.add(root);
				root = opts.parentMap.get(root) ?? root;
			}
			const state = subtree.get(root) ?? {
				processing: false,
				unread: false,
				questions: 0,
				permissions: 0,
			};
			const status = opts.statuses?.[id]?.type ?? rowStatuses.get(id);
			state.processing ||=
				status === "busy" ||
				status === "retry" ||
				opts.hasLiveBackgroundWork?.(id) === true;
			state.unread ||= opts.unreadSessionIds?.has(id) === true;
			state.questions += opts.pendingQuestionCounts?.get(id) ?? 0;
			state.permissions += opts.pendingPermissionCounts?.get(id) ?? 0;
			subtree.set(root, state);
		}
	}
	return rows.map((row) => {
		const parentID = row.parent_id ?? undefined;
		const state = parentID ? undefined : subtree.get(row.id);
		const pendingQuestionCount =
			state?.questions ?? opts.pendingQuestionCounts?.get(row.id);
		const pendingPermissionCount =
			state?.permissions ?? opts.pendingPermissionCounts?.get(row.id);
		const unread = row.unread === 1;
		const status = opts.statuses?.[row.id]?.type ?? row.status;
		const processing =
			state?.processing ||
			status === "busy" ||
			status === "retry" ||
			opts.hasLiveBackgroundWork?.(row.id) === true;
		let attention: SessionAttention = "idle";
		if ((pendingPermissionCount ?? 0) > 0) attention = "needs-approval";
		else if ((pendingQuestionCount ?? 0) > 0) attention = "needs-reply";
		else if (row.last_turn_error_at !== null) attention = "error";
		else if (processing) attention = "working";
		else if (state?.unread || unread) attention = "done-unread";
		return {
			id: row.id,
			title: row.title,
			status:
				row.status === "busy" ||
				row.status === "retry" ||
				row.status === "error"
					? row.status
					: "idle",
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			messageCount: 0,
			...(parentID ? { parentID } : {}),
			...(row.fork_point_event ? { forkMessageId: row.fork_point_event } : {}),
			...(row.fork_point_timestamp != null
				? { forkPointTimestamp: row.fork_point_timestamp }
				: {}),
			...(row.fork_point_message_id != null
				? { forkPointMessageId: row.fork_point_message_id }
				: {}),
			...(processing ? { processing: true } : {}),
			...(pendingQuestionCount ? { pendingQuestionCount } : {}),
			...(pendingPermissionCount ? { pendingPermissionCount } : {}),
			...(unread ? { unread: true } : {}),
			...(row.last_turn_end_version != null
				? { lastTurnEndVersion: row.last_turn_end_version }
				: {}),
			...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
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

	readonly getAllSessionStatuses: () => Effect.Effect<
		Record<string, string>,
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
		hasLiveBackgroundWork?: (sessionId: string) => boolean;
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
			}[];
			count: number;
		},
		ReadQueryEffectError | SqlError
	>;

	readonly getSessionFamily: (
		sessionId: string,
	) => Effect.Effect<readonly SessionRow[], ReadQueryEffectError | SqlError>;

	readonly countPendingApprovalsBySession: () => Effect.Effect<
		readonly PendingApprovalCountRow[],
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
	readonly readSessionTranscriptPage: (
		sessionId: string,
		options: { readonly before?: string; readonly limit: number },
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

/** Attach each part to its message, preserving message and part order. */
function groupMessagesWithParts(
	messages: readonly MessageRow[],
	parts: readonly MessagePartRow[],
): MessageWithParts[] {
	const partsByMessage = new Map<string, MessagePartRow[]>();
	for (const part of parts) {
		let existing = partsByMessage.get(part.message_id);
		if (!existing) {
			existing = [];
			partsByMessage.set(part.message_id, existing);
		}
		existing.push(part);
	}
	return messages.map((message) => ({
		...message,
		parts: partsByMessage.get(message.id) ?? [],
	}));
}

type MessageWithTurnModelRow = MessageRow & {
	turn_requested_model: string | null;
	turn_expected_model: string | null;
	turn_actual_model: string | null;
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
			...messageRow
		} = message;
		return {
			...messageRow,
			parts: partsByMessage.get(message.id) ?? [],
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

	const getToolContent = (
		toolId: string,
	): Effect.Effect<string | undefined, ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ content: string }>`
				SELECT content FROM tool_content WHERE tool_id = ${toolId}`;
			return rows[0]?.content;
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

	// ─── The session list reads ───────────────────────────────────────────
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
			}>`
				SELECT id, parent_id, unread FROM sessions`;
			const counts = yield* sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM sessions`;
			return { rows, count: counts[0]?.count ?? 0 };
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ReadQueryEffectError({ operation: "getSessionLineage", cause }),
			),
		);

	const getSessionFamily = (sessionId: string) =>
		sql
			.unsafe<SessionRow>(sessionFamilyQuery, [sessionId])
			.pipe(
				Effect.mapError(
					(cause) =>
						new ReadQueryEffectError({ operation: "getSessionFamily", cause }),
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
			const [rows, lineage, approvals, projectedStatuses] = yield* Effect.all([
				listSessions(opts),
				getSessionLineage(),
				countPendingApprovalsBySession(),
				getAllSessionStatuses(),
			]);
			const pending = pendingApprovalCountsByType(approvals);
			return sessionRowsToSessionInfoList(rows, {
				parentMap: new Map(
					lineage.rows.flatMap((row) =>
						row.parent_id === null ? [] : [[row.id, row.parent_id] as const],
					),
				),
				unreadSessionIds: new Set(
					lineage.rows.flatMap((row) => (row.unread === 1 ? [row.id] : [])),
				),
				statuses: {
					...Object.fromEntries(
						Object.entries(projectedStatuses).map(([id, type]) => [
							id,
							{ type },
						]),
					),
					...opts?.statuses,
				},
				pendingQuestionCounts: pending.questions,
				pendingPermissionCounts: pending.permissions,
				...(opts?.hasLiveBackgroundWork && {
					hasLiveBackgroundWork: opts.hasLiveBackgroundWork,
				}),
			});
		});

	const listPendingClaudeQuestionTools = () =>
		sql<PendingClaudeQuestionToolRow>`
			SELECT mp.id, mp.call_id, mp.message_id, mp.input, mp.created_at, m.session_id
			FROM message_parts mp
			JOIN messages m ON m.id = mp.message_id
			JOIN sessions s ON s.id = m.session_id
			WHERE s.provider = 'claude'
				AND mp.type = 'tool'
				AND mp.tool_name = 'AskUserQuestion'
				AND mp.status IN ('started', 'running', 'pending')
				-- A later user message means the conversation moved on (e.g. after a
				-- crash), so the question is abandoned rather than still pending.
				AND NOT EXISTS (
					SELECT 1 FROM messages later
					WHERE later.session_id = m.session_id
						AND later.role = 'user'
						AND later.created_at > m.created_at
				)`.pipe(
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
					turns.actual_model AS turn_actual_model
				FROM messages
				LEFT JOIN turns ON turns.id = messages.turn_id
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

	// ─── The versioned subscription reads ─────────────────────────────────
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
		options: { readonly before?: string; readonly limit: number },
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
					const cursor =
						options.before !== undefined
							? (yield* sql<{ created_at: number; id: string }>`
									SELECT created_at, id FROM messages
									WHERE session_id = ${sessionId} AND id = ${options.before}`)[0]
							: undefined;
					if (options.before !== undefined && !cursor) {
						return yield* new TranscriptPageCursorNotFoundError({
							sessionId,
							before: options.before,
						});
					}
					const rows = cursor
						? yield* sql<MessageWithTurnModelRow>`
								SELECT messages.*,
									turns.requested_model AS turn_requested_model,
									turns.expected_model AS turn_expected_model,
									turns.actual_model AS turn_actual_model
								FROM messages
								LEFT JOIN turns ON turns.id = messages.turn_id
								WHERE messages.session_id = ${sessionId}
									AND (messages.created_at < ${cursor.created_at}
										OR (messages.created_at = ${cursor.created_at} AND messages.id < ${cursor.id}))
								ORDER BY messages.created_at DESC, messages.id DESC
								LIMIT ${options.limit + 1}`
						: yield* sql<MessageWithTurnModelRow>`
								SELECT messages.*,
									turns.requested_model AS turn_requested_model,
									turns.expected_model AS turn_expected_model,
									turns.actual_model AS turn_actual_model
								FROM messages
								LEFT JOIN turns ON turns.id = messages.turn_id
								WHERE messages.session_id = ${sessionId}
								ORDER BY messages.created_at DESC, messages.id DESC
								LIMIT ${options.limit + 1}`;
					const page = rows.slice(0, options.limit).reverse();
					const parts = page.length
						? yield* sql<MessagePartRow>`
								SELECT * FROM message_parts
								WHERE message_id IN ${sql.in(page.map((message) => message.id))}
								ORDER BY message_id, sort_order`
						: [];
					return {
						messages: groupMessagesWithPartsAndTurnModels(page, parts),
						hasMore: rows.length > options.limit,
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
					const rows = range?.roots
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
					});
					return {
						rows: rows.map((row, index) => ({
							item: items[index]!,
							version: range?.roots
								? (row as SessionRow & { effective_version: number })
										.effective_version
								: row.version,
						})),
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
					const messages = yield* sql<MessageRow>`
						SELECT * FROM messages
						WHERE session_id = ${sessionId}
							AND version > ${floor} AND version <= ${ceiling}
						ORDER BY created_at ASC, id ASC`;

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
						messages: groupMessagesWithParts(messages, parts),
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
		getAllSessionStatuses,
		listSessions,
		listSessionInfos,
		getSessionLineage,
		getSessionFamily,
		getSessionsForReconciliation,
		countPendingApprovalsBySession,
		listPendingClaudeQuestionTools,
		getPendingClaudeQuestionTool,
		getSessionMessagesWithParts,
		readSessionTranscriptPage,
		readSessionList,
		readSessionTranscript,
		getLatestTurnModelExecution,
	} satisfies ReadQueryEffect;
});
