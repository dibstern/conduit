// How a session leaves the read model, and why that is not a rule anyone has to
// remember.
//
// A row that moves announces itself by its version stamp. A row that is deleted
// leaves nothing behind to stamp, and the `ON DELETE CASCADE` on
// sessions.parent_id takes the subagent subtree *inside SQLite*, where no
// statement names it and `RETURNING` never sees it — a recursive-CTE delete
// still reports only the row it started from, because the cascade has already
// taken the descendants by the time the statement reaches them. So the removal
// has to be named before it happens. It is named here, once.
//
// The discipline cannot spread to callers, because there is no per-caller step
// to spread:
//
//   - A handler declares `{ removeSession }` rather than writing DELETE SQL, and
//     the Effect projector's removal arm reads the subtree, performs the
//     delete, and reports every id. (The legacy projector executes the same
//     statement but reports nothing; it has no advance to report into.) The
//     cascade still does all the actual cleanup, in every dependent table; the
//     pre-read exists only so the bus can be told.
//   - Anything else that removes a session is reported anyway: the projector
//     classifies a row a statement wrote but could not stamp afterwards as
//     removed. Inside the projection path, "delete and say nothing" is not a
//     thing a statement can do.
//   - The one remaining way to remove a session silently is to write a second
//     delete statement. That is what fails loudly:
//     test/unit/persistence/session-removal-boundary-grep.guard.test.ts allows
//     exactly one `DELETE FROM sessions` in the whole of src — the
//     REMOVE_SESSION_SQL declaration below — and allows it to be executed only
//     by the two projectors. Being inside this file buys nothing: a raw delete
//     here would be run as an ordinary write, with `RETURNING id` appended, and
//     would report the row it deleted while the cascade took the subtree in
//     silence. So a new delete path anywhere, inside the seam or outside it,
//     breaks the suite the moment it is written, with the fix named in the
//     failure message. The legacy skeleton migration delete sits outside and is
//     listed there with its reason; adding another gap is a deliberate act.
//
// Bead conduit-test-ni8.5.12.

import {
	AUTO_TITLE_SOURCE,
	isPlaceholderTitle,
	placeholderTitleSql,
} from "../../contracts/session-title.js";
import {
	decodeClaudeWorktreeState,
	projectClaudeWorktreeState,
} from "../../session/claude-worktree-state.js";
import type {
	CanonicalEventType,
	EventPayloadMap,
	LiveEventType,
	StoredEvent,
} from "../events.js";

export function isHumanSentMessage(
	message: {
		role: string;
		inherited: boolean;
		inputId: string | null;
		synthetic: boolean;
		legacyText: string;
	},
	parts: readonly { type: unknown; synthetic?: unknown; ignored?: unknown }[],
): boolean {
	// Fork copies are context, even when they retain the original input id.
	if (message.role !== "user" || message.inherited) return false;
	// Conduit assigns an input id only when delivering a human's input.
	if (message.inputId !== null) return true;
	// OpenCode injects synthetic/ignored context alongside ordinary user parts.
	if (message.synthetic) return false;
	return (
		parts.some(
			(part) =>
				(part.type === "text" || part.type === "file") &&
				part.synthetic !== true &&
				part.ignored !== true,
		) ||
		(parts.length === 0 && message.legacyText !== "")
	);
}

/** A write against `sessions`, executed with `RETURNING id` appended. */
export interface SessionWrite {
	readonly sql: string;
	readonly params: readonly (string | number | null)[];
}

/**
 * A session to remove, named rather than written as SQL. The projector owns the
 * removal because reporting it needs a read the cascade would otherwise make
 * impossible — see the note at the top of this file.
 */
export interface SessionRemoval {
	readonly removeSession: string;
}

export type SessionStatement = SessionWrite | SessionRemoval;

export const isSessionRemoval = (
	statement: SessionStatement,
): statement is SessionRemoval => "removeSession" in statement;

/**
 * The only statement in the source that removes session rows. Every projector
 * that executes a removal runs this one, so the boundary grep has a single
 * place to allow and a new delete path has nowhere quiet to live.
 */
export const REMOVE_SESSION_SQL = "DELETE FROM sessions WHERE id = ?";

/**
 * The session and every subagent beneath it, read before the removal — the
 * cascade takes the descendants without naming them, and reports nothing once
 * they are gone. It returns nothing for a session that is already absent, which
 * is what keeps a replayed delete quiet.
 */
export const SESSION_SUBTREE_SQL = `WITH RECURSIVE subtree(id) AS (
	SELECT id FROM sessions WHERE id = ?
	UNION
	SELECT child.id FROM sessions child JOIN subtree ON child.parent_id = subtree.id
)
SELECT id FROM subtree`;

function sessionPlacement(
	event:
		| { type: "session.created"; data: EventPayloadMap["session.created"] }
		| { type: "session.forked"; data: EventPayloadMap["session.forked"] },
): { parentId: string | null; forkedFrom: string | null; sideThread: boolean } {
	if (event.type === "session.forked") {
		return {
			parentId: null,
			forkedFrom: event.data.parentId,
			sideThread: false,
		};
	}
	const payload = event.data;
	const sideThread = payload.sideThread === true;
	const legacyFork =
		payload.parentId !== undefined &&
		payload.forkedFrom === undefined &&
		payload.sideThread === undefined &&
		(payload.forkPointEvent !== undefined ||
			payload.forkPointTimestamp !== undefined);
	return {
		parentId: legacyFork ? null : (payload.parentId ?? null),
		forkedFrom:
			payload.forkedFrom ??
			(sideThread || legacyFork ? payload.parentId : undefined) ??
			null,
		sideThread,
	};
}

// An approval or question in a child rolls up into its root's attention, so it
// must wake a snoozed ancestor too; otherwise the root sits on the shelf while
// blocked on you. A child's turn ending or failing is not what was awaited.
function wakeSession(
	sessionId: string,
	createdAt: number,
	reason: "approval" | "question" | "error" | "turn",
): SessionStatement {
	const blocksOnUser = reason === "approval" || reason === "question";
	const target = blocksOnUser
		? `id IN (WITH RECURSIVE lineage(id) AS (
				SELECT ? UNION SELECT s.parent_id FROM sessions s
				JOIN lineage ON s.id = lineage.id WHERE s.parent_id IS NOT NULL
			) SELECT id FROM lineage)`
		: "id = ?";
	return {
		sql: `UPDATE sessions SET woken_at = ?, woken_reason = ?
			WHERE ${target} AND snoozed_at IS NOT NULL AND woken_at IS NULL
			AND snoozed_at <= ? AND (snoozed_until IS NULL OR snoozed_until > ?)`,
		params: [createdAt, reason, sessionId, createdAt, createdAt],
	};
}

// Claude ownership emits child status, while Task tool parts provide a fallback
// through metadata.childSessionId (conduit-test-zbct). OpenCode children emit
// their own session.status and
// name the child under `sessionId`, so none of this touches them. Parts are
// read before the message projector applies the same event, and corrupt
// metadata reads as no child rather than failing the projection.
const PART_CHILD =
	"CASE WHEN json_valid(p.metadata) THEN json_extract(p.metadata, '$.childSessionId') END";
const PART_BACKGROUND_RUNNING =
	"CASE WHEN json_valid(p.metadata) THEN COALESCE(json_extract(p.metadata, '$.backgrounded'), 0) = 1 AND json_extract(p.metadata, '$.outcome') IS NULL ELSE 0 END";

// A parent turn that is interrupted or fails leaves its foreground Task parts
// open. Background tasks keep running until their own outcome arrives.
function settleOpenSubagents(
	parentSessionId: string,
	createdAt: number,
): SessionStatement {
	return {
		sql: `WITH RECURSIVE foreground(id) AS (
				SELECT ? UNION
				SELECT ${PART_CHILD} FROM foreground f
				JOIN messages m ON m.session_id = f.id
				JOIN message_parts p ON p.message_id = m.id
				WHERE p.type = 'tool' AND p.status IN ('started', 'running')
				AND ${PART_CHILD} IS NOT NULL AND NOT (${PART_BACKGROUND_RUNNING}))
			UPDATE sessions SET status = 'idle', updated_at = ?
			WHERE status IN ('busy', 'retry') AND id <> ? AND id IN (SELECT id FROM foreground)`,
		params: [parentSessionId, createdAt, parentSessionId],
	};
}

// A turn's end advances the turn-end version and names the send the turn
// answered, so a browser can tell a late end of an earlier turn from the end of
// the one it is waiting on (conduit-test-jyr9.10). The id is NULL when the
// ended turn has no known send.
// Transcript turns split at each steer; messages.steered retains which inputs
// joined a provider turn.
function endTurn(
	event: Pick<StoredEvent, "createdAt" | "sessionId" | "streamVersion">,
	errorAt: number | null,
	userMessageId: string | null,
	messageId: string,
): SessionStatement {
	return {
		sql: `WITH ended_input AS (
			SELECT input_id, session_id, steered, rowid AS position FROM messages
			WHERE id = COALESCE(?,
				(SELECT COALESCE(turn_id, parent_id) FROM messages WHERE id = ?)))
		UPDATE sessions SET updated_at = ?, last_turn_error_at = ?,
			last_turn_end_input_id = CASE WHEN ? > COALESCE(last_turn_end_version, -1)
				THEN (SELECT CASE WHEN ended.steered = 1 THEN
					(SELECT starter.input_id FROM messages starter
						WHERE starter.session_id = ended.session_id AND starter.role = 'user'
						AND starter.steered = 0 AND starter.is_backfilled = 0
						AND starter.rowid <= ended.position ORDER BY starter.rowid DESC LIMIT 1)
					ELSE ended.input_id END FROM ended_input ended)
				ELSE last_turn_end_input_id END,
			last_turn_end_version = MAX(COALESCE(last_turn_end_version, -1), ?)
			WHERE id = ?`,
		params: [
			userMessageId,
			messageId,
			event.createdAt,
			errorAt,
			event.streamVersion,
			event.streamVersion,
			event.sessionId,
		],
	};
}

function isAutoTitleRename(event: StoredEvent): boolean {
	return event.metadata.source === AUTO_TITLE_SOURCE;
}

// last_turn_error_at answers one durable question rather than mirroring the
// turn state machine: failures set it, while success or new work clears it.
//
// Keys declare the session projector's handled events and type each payload.
// Cross-projector coverage is checked beside the projector factory list.
export const sessionHandlers = {
	"session.rewound": (event) => [
		{
			sql: "UPDATE sessions SET pending_rewind_message_id = ?, updated_at = ? WHERE id = ?",
			params: [event.data.messageId, event.createdAt, event.sessionId],
		},
	],
	"session.rewind_undone": (event) => [
		{
			sql: "UPDATE sessions SET pending_rewind_message_id = NULL, updated_at = ? WHERE id = ?",
			params: [event.createdAt, event.sessionId],
		},
	],
	"session.rewind_committed": (event) => [
		{
			sql: "UPDATE sessions SET pending_rewind_message_id = NULL, updated_at = ? WHERE id = ?",
			params: [event.createdAt, event.sessionId],
		},
	],
	"session.created": (event) => {
		const placement = sessionPlacement(event);
		// Use INSERT ... ON CONFLICT DO UPDATE instead of INSERT OR REPLACE
		// to preserve user/auto-renamed titles plus nullable columns
		// (provider_sid, parent_id, forked_from, fork_point_event) that may have been set by
		// other code paths. A Fork never takes a parent, whichever creation lands
		// last: OpenCode ingress can seed the native parentID after the Fork.
		return [
			{
				sql: `INSERT INTO sessions (id, project_id, provider, provider_sid, title, status, parent_id, forked_from, fork_point_event, side_thread, permission_mode, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (id) DO UPDATE SET
					     -- Claim an unowned row, but never move a session to another project.
					     project_id = COALESCE(NULLIF(sessions.project_id, ''), excluded.project_id),
					     provider = CASE
					       WHEN EXISTS (
					         SELECT 1 FROM session_providers
					         WHERE session_id = sessions.id AND status = 'active'
					       )
					       THEN sessions.provider
					       WHEN sessions.provider NOT IN ('opencode', 'claude')
					       THEN sessions.provider
					       ELSE excluded.provider
					     END,
				     provider_sid = COALESCE(excluded.provider_sid, sessions.provider_sid),
				     title = CASE
				       WHEN sessions.title IS NULL
				         OR sessions.title = ''
				         OR sessions.title IN ('Untitled', 'Claude Session', 'Test Session')
				         OR sessions.title LIKE 'New session%'
				         OR sessions.parent_id IS NOT NULL
				         OR excluded.parent_id IS NOT NULL
				         OR excluded.forked_from IS NOT NULL
				       THEN excluded.title
				       ELSE sessions.title
				     END,
				     parent_id = CASE
				       WHEN COALESCE(excluded.forked_from, sessions.forked_from) IS NOT NULL
				         AND MAX(sessions.side_thread, excluded.side_thread) = 0
				       THEN NULL
				       ELSE COALESCE(excluded.parent_id, sessions.parent_id)
				     END,
				     forked_from = COALESCE(excluded.forked_from, sessions.forked_from),
				     fork_point_event = COALESCE(excluded.fork_point_event, sessions.fork_point_event),
				     side_thread = MAX(sessions.side_thread, excluded.side_thread),
				     permission_mode = COALESCE(sessions.permission_mode, excluded.permission_mode),
				     updated_at = excluded.updated_at`,
				params: [
					event.data.sessionId,
					event.projectId,
					event.data.provider,
					event.data.providerSessionId ?? null,
					event.data.title,
					placement.parentId,
					placement.forkedFrom,
					event.data.forkPointEvent ?? null,
					placement.sideThread ? 1 : 0,
					event.data.permissionMode ?? null,
					event.createdAt,
					event.createdAt,
				],
			},
		];
	},

	"session.renamed": (event) => {
		if (isAutoTitleRename(event)) {
			return [
				{
					sql: `UPDATE sessions SET title = ?, updated_at = ?
					 WHERE id = ?
					   AND NOT EXISTS (
					     SELECT 1
					     FROM events prior
					     WHERE prior.session_id = ?
					       AND prior.type = 'session.renamed'
					       AND prior.sequence < ?
					       AND COALESCE(json_extract(prior.metadata, '$.source'), '') <> '${AUTO_TITLE_SOURCE}'
					       AND NOT ${placeholderTitleSql("json_extract(prior.data, '$.title')")}
					   )
					   AND ${placeholderTitleSql("title")}`,
					params: [
						event.data.title,
						event.createdAt,
						event.data.sessionId,
						event.data.sessionId,
						event.sequence,
					],
				},
			];
		}
		// A placeholder (e.g. OpenCode echoing "Untitled") never replaces a real title.
		const keepRealTitle = isPlaceholderTitle(event.data.title)
			? ` AND ${placeholderTitleSql("title")}`
			: "";
		return [
			{
				sql: `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?${keepRealTitle}`,
				params: [event.data.title, event.createdAt, event.data.sessionId],
			},
		];
	},

	"session.settled": (event) => [
		{
			sql: "UPDATE sessions SET settled_at = ?, settled_automatically = ? WHERE id = ?",
			params: [
				event.createdAt,
				event.data.automatic === true ? 1 : 0,
				event.data.sessionId,
			],
		},
	],

	"session.workspace_changed": (event) =>
		event.data.cause === "branch-rename"
			? []
			: [
					{
						sql: `UPDATE sessions SET workspace = ?,
				workspace_hint = CASE WHEN workspace_hint = ? THEN NULL ELSE workspace_hint END,
				workspace_hint_sequence = CASE WHEN workspace_hint = ? THEN NULL ELSE workspace_hint_sequence END
				WHERE id = ?`,
						params: [
							// Keep fallback and origin metadata on the existing browser session row.
							Object.keys(event.data.worktrees).length === 0 &&
							event.data.cause !== "missing" &&
							event.data.origin === "existing"
								? null
								: JSON.stringify({
										cause: event.data.cause,
										worktrees: event.data.worktrees,
										origin: event.data.origin,
									}),
							event.data.path ?? null,
							event.data.path ?? null,
							event.data.sessionId,
						],
					},
				],
	"session.workspace_hint_changed": (event) => {
		const sequence = event.data.path === null ? null : event.sequence;
		return [
			{
				sql: `UPDATE sessions SET workspace_hint = ?, workspace_hint_sequence = ?
					WHERE id = ? AND (workspace_hint IS NOT ? OR workspace_hint_sequence IS NOT ?)`,
				params: [
					event.data.path,
					sequence,
					event.sessionId,
					event.data.path,
					sequence,
				],
			},
		];
	},
	"session.workspace_started": () => [],
	"input.sent": () => [],

	"session.unsettled": (event) => [
		{
			sql: "UPDATE sessions SET settled_at = NULL, settled_automatically = 0, unsettled_at = ? WHERE id = ?",
			params: [event.createdAt, event.data.sessionId],
		},
	],
	"session.archived": (event) => [
		{
			sql: "UPDATE sessions SET archived_at = ?, archived_automatically = ? WHERE id = ?",
			params: [
				event.createdAt,
				event.data.automatic ? 1 : 0,
				event.data.sessionId,
			],
		},
	],
	"session.unarchived": (event) => [
		{
			sql: "UPDATE sessions SET archived_at = NULL, archived_automatically = 0, unarchived_at = ? WHERE id = ?",
			params: [event.createdAt, event.data.sessionId],
		},
	],

	"session.pinned": (event) => [
		{
			sql: "UPDATE sessions SET pinned_at = ? WHERE id = ?",
			params: [event.createdAt, event.data.sessionId],
		},
	],

	"session.unpinned": (event) => [
		{
			sql: "UPDATE sessions SET pinned_at = NULL WHERE id = ?",
			params: [event.data.sessionId],
		},
	],

	"session.snoozed": (event) => [
		{
			sql: `UPDATE sessions SET snoozed_at = ?, snoozed_until = ?,
				woken_at = NULL, woken_reason = NULL WHERE id = ?`,
			params: [event.createdAt, event.data.until, event.data.sessionId],
		},
	],

	"session.auto_settle_set": (event) => [
		{
			sql: "UPDATE sessions SET auto_settle_disabled_at = ? WHERE id = ?",
			params: [
				event.data.disabled ? event.createdAt : null,
				event.data.sessionId,
			],
		},
	],

	"session.unsnoozed": (event) => [
		{
			sql: `UPDATE sessions SET snoozed_at = NULL, snoozed_until = NULL,
				woken_at = NULL, woken_reason = NULL WHERE id = ?`,
			params: [event.data.sessionId],
		},
	],

	"session.deleted": (event) => {
		// sessions.parent_id, turns.session_id, messages.session_id/turn_id,
		// message_parts.message_id, and every other FK into sessions/turns carry
		// ON DELETE CASCADE (see 0010_session_cascade_deletes.sql), so deleting
		// the session row alone removes every dependent row, including subagent
		// children reachable through parent_id. The cascade keeps doing that; the
		// projector names the session subtree first so the removal can be
		// announced. See the note at the top of this file.
		return [{ removeSession: event.data.sessionId }];
	},

	// A legacy upstream creation can contain a Fork before this lineage event
	// identifies it. Side Threads keep their explicit containment. The row is
	// created by session.created; this event has no title or provider to insert.
	"session.forked": (event) => {
		const placement = sessionPlacement(event);
		return [
			{
				sql: `UPDATE sessions SET
					parent_id = CASE WHEN side_thread = 1 THEN parent_id ELSE ? END,
					forked_from = ?,
					fork_point_event = COALESCE(?, fork_point_event),
					updated_at = ?
				 WHERE id = ?`,
				params: [
					placement.parentId,
					placement.forkedFrom,
					event.data.forkPointEvent ?? null,
					event.createdAt,
					event.data.sessionId,
				],
			},
		];
	},

	"session.status": (event) => {
		const startsNewWork =
			event.data.status === "busy" || event.data.status === "retry";
		return [
			{
				sql: startsNewWork
					? "UPDATE sessions SET status = ?, updated_at = ?, last_turn_error_at = NULL WHERE id = ?"
					: "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
				params: [event.data.status, event.createdAt, event.data.sessionId],
			},
		];
	},

	"session.provider_changed": (event) => {
		return [
			{
				sql: "UPDATE sessions SET provider = ?, updated_at = ? WHERE id = ?",
				params: [event.data.newProvider, event.createdAt, event.data.sessionId],
			},
			{
				sql: "UPDATE sessions SET limit_recovery = CASE WHEN json_extract(limit_recovery, '$.cutOffMessageId') IS NULL THEN NULL ELSE json_remove(json_set(limit_recovery, '$.continued', json('true'), '$.switched', json('true')), '$.scheduledAt') END WHERE id = ? AND limit_recovery IS NOT NULL",
				params: [event.data.sessionId],
			},
		];
	},

	"session.permission_mode_changed": (event) => {
		return [
			{
				sql: "UPDATE sessions SET permission_mode = ?, updated_at = ? WHERE id = ?",
				params: [event.data.mode, event.createdAt, event.data.sessionId],
			},
		];
	},

	// Model settings are not activity, so they leave updated_at (sidebar
	// order) alone; the projection still stamps the row version.
	"session.model_changed": (event) => [
		{
			sql: "UPDATE sessions SET model_id = ?, model_provider = ? WHERE id = ?",
			params: [event.data.modelId, event.data.providerId, event.data.sessionId],
		},
	],

	"session.variant_changed": (event) => [
		{
			sql: "UPDATE sessions SET variant = ? WHERE id = ?",
			params: [event.data.variant, event.data.sessionId],
		},
	],

	"session.context_window_changed": (event) => [
		{
			sql: "UPDATE sessions SET context_window = ? WHERE id = ?",
			params: [event.data.contextWindow, event.data.sessionId],
		},
	],

	"session.goal_changed": (event) => [
		{
			sql: "UPDATE sessions SET goal_state = ?, updated_at = ? WHERE id = ?",
			params: [
				JSON.stringify(event.data),
				event.createdAt,
				event.data.sessionId,
			],
		},
	],

	"session.usage_limited": (event) => [
		{
			sql: "UPDATE sessions SET limit_recovery = ?, updated_at = ? WHERE id = ?",
			params: [
				JSON.stringify({ ...event.data, rearms: 0, continued: false }),
				event.createdAt,
				event.sessionId,
			],
		},
	],
	"session.cut_off_dismissed": (event) => [
		{
			sql: "UPDATE sessions SET limit_recovery = json_remove(limit_recovery, '$.cutOffMessageId'), updated_at = ? WHERE id = ? AND json_extract(limit_recovery, '$.cutOffMessageId') = ?",
			params: [event.createdAt, event.sessionId, event.data.cutOffMessageId],
		},
	],
	"session.resumed": (event) => [
		{
			sql: "UPDATE sessions SET limit_recovery = json_remove(json_set(limit_recovery, '$.continued', json('true')), '$.scheduledAt', '$.auto'), updated_at = ? WHERE id = ? AND provider = ? AND limit_recovery IS NOT NULL",
			params: [event.createdAt, event.sessionId, event.data.instanceId],
		},
		{
			// The transcript divider outlives limit_recovery, which the reply nulls.
			sql: "UPDATE sessions SET resumes = json_insert(resumes, '$[#]', json(?)), updated_at = ? WHERE id = ?",
			params: [
				JSON.stringify({
					at: event.createdAt,
					instanceId: event.data.instanceId,
					reason: event.data.reason,
					...(event.data.from === undefined ? {} : { from: event.data.from }),
				}),
				event.createdAt,
				event.sessionId,
			],
		},
	],
	"session.resume_scheduled": (event) => {
		const source = event.metadata.source;
		// A queue can wait for its account's reset without a cut-off turn.
		const recovery =
			"COALESCE(limit_recovery, json_object('instanceId', ?, 'rateLimitType', 'usage', 'resetsAt', ?, 'rearms', 0, 'continued', json('false')))";
		// The limit policy marks its schedule, a user's schedule clears the mark,
		// and a sweep re-arm keeps whichever one it re-arms.
		const marked =
			source === "limit-policy"
				? `json_set(${recovery}, '$.auto', json('true'))`
				: source === "continuation-sweep"
					? recovery
					: `json_remove(${recovery}, '$.auto')`;
		return [
			{
				// Only the sweep re-arms. A user changing the time is still scheduling.
				sql: `UPDATE sessions SET limit_recovery = json_set(${marked}, '$.scheduledAt', ?, '$.rearms', COALESCE(json_extract(limit_recovery, '$.rearms'), 0) + ?), updated_at = ? WHERE id = ? AND provider = ? AND (limit_recovery IS NULL OR json_extract(limit_recovery, '$.instanceId') = ?)`,
				params: [
					event.data.instanceId,
					event.data.at,
					event.data.at,
					source === "continuation-sweep" ? 1 : 0,
					event.createdAt,
					event.sessionId,
					event.data.instanceId,
					event.data.instanceId,
				],
			},
		];
	},
	"session.resume_cancelled": (event) => [
		{
			sql:
				event.metadata.source === "inbox-reset"
					? "UPDATE sessions SET limit_recovery = NULL, updated_at = ? WHERE id = ? AND json_extract(limit_recovery, '$.cutOffMessageId') IS NULL"
					: "UPDATE sessions SET limit_recovery = json_remove(limit_recovery, '$.scheduledAt', '$.auto'), updated_at = ? WHERE id = ?",
			params: [event.createdAt, event.sessionId],
		},
	],

	// Task outcomes settle background children. Only the first attach to an
	// open part starts a child; repeated links cannot reopen a settled child.
	// Runners older than the `outcome` stamp report only the raw task status,
	// and they outlive daemon upgrades, so a terminal status settles too.
	"tool.running": (event) => {
		const child = event.data.metadata?.["childSessionId"];
		const outcome =
			event.data.metadata?.["outcome"] ?? event.data.metadata?.["status"];
		if (
			outcome === "completed" ||
			outcome === "failed" ||
			outcome === "stopped" ||
			outcome === "killed"
		)
			return [
				{
					sql: `UPDATE sessions SET status = 'idle', updated_at = ?
						WHERE status IN ('busy', 'retry') AND id = COALESCE(?,
							(SELECT ${PART_CHILD} FROM message_parts p WHERE p.id = ?))`,
					params: [
						event.createdAt,
						typeof child === "string" ? child : null,
						event.data.partId,
					],
				},
			];
		if (event.data.metadata?.["backgrounded"] === true)
			return [
				{
					sql: `UPDATE sessions SET status = 'busy', updated_at = ?
						WHERE id = COALESCE(?, (SELECT ${PART_CHILD} FROM message_parts p WHERE p.id = ?))
						AND status <> 'busy' AND NOT EXISTS (
							SELECT 1 FROM message_parts p WHERE p.id = ? AND json_valid(p.metadata)
							AND json_extract(p.metadata, '$.outcome') IS NOT NULL)`,
					params: [
						event.createdAt,
						typeof child === "string" ? child : null,
						event.data.partId,
						event.data.partId,
					],
				},
			];
		if (typeof child !== "string") return [];
		return [
			{
				sql: `UPDATE sessions SET status = 'busy', updated_at = ?
					WHERE id = ? AND status <> 'busy' AND NOT EXISTS (
						SELECT 1 FROM message_parts p WHERE p.id = ?
						AND (p.status IN ('completed', 'error') OR ${PART_CHILD} IS NOT NULL))`,
				params: [event.createdAt, child, event.data.partId],
			},
		];
	},
	// Completion rarely repeats the child id, so fall back to the one the part
	// already holds.
	"tool.completed": (event) => {
		const child = event.data.metadata?.["childSessionId"];
		return [
			{
				sql: `UPDATE sessions SET status = 'idle', updated_at = ?
					WHERE status IN ('busy', 'retry') AND id = COALESCE(?,
						(SELECT ${PART_CHILD} FROM message_parts p WHERE p.id = ?))
					AND NOT EXISTS (SELECT 1 FROM message_parts p
						WHERE p.id = ? AND (${PART_BACKGROUND_RUNNING}))`,
				params: [
					event.createdAt,
					typeof child === "string" ? child : null,
					event.data.partId,
					event.data.partId,
				],
			},
		];
	},
	"turn.completed": (event) => [
		wakeSession(event.sessionId, event.createdAt, "turn"),
		endTurn(
			event,
			null,
			event.data.userMessageId ?? null,
			event.data.messageId,
		),
	],
	"turn.error": (event) => [
		wakeSession(event.sessionId, event.createdAt, "error"),
		endTurn(
			event,
			event.createdAt,
			event.data.userMessageId ?? null,
			event.data.messageId,
		),
		settleOpenSubagents(event.sessionId, event.createdAt),
	],
	"turn.interrupted": (event) => [
		endTurn(event, null, null, event.data.messageId),
		settleOpenSubagents(event.sessionId, event.createdAt),
	],
	"permission.asked": (event) => [
		wakeSession(event.data.sessionId, event.createdAt, "approval"),
	],
	"question.asked": (event) => [
		wakeSession(event.data.sessionId, event.createdAt, "question"),
	],

	// (P8) Denormalize last_message_at on the session. Owned by
	// SessionProjector (not MessageProjector) to keep all session-table
	// mutations in one projector.
	"message.created": (event) => {
		const startsNewTurn = event.data.role === "user";
		return [
			{
				sql: `UPDATE sessions SET
					last_message_at = MAX(COALESCE(last_message_at, 0), ?),
					updated_at = ?${startsNewTurn ? ",\n\t\t\t\t\tlast_turn_error_at = NULL" : event.data.backfilled ? "" : ",\n\t\t\t\t\tlimit_recovery = NULL"}
				 WHERE id = ?`,
				params: [event.createdAt, event.createdAt, event.data.sessionId],
			},
		];
	},
} satisfies {
	readonly [K in LiveEventType]?: (
		event: Extract<StoredEvent, { type: K }>,
	) => readonly SessionStatement[];
};

type SessionHandledTypes = [
	keyof typeof sessionHandlers,
	...(keyof typeof sessionHandlers)[],
];

// The handler table is nonempty; every handled type comes from its keys.
export const SESSION_HANDLED_TYPES: Readonly<SessionHandledTypes> = Object.keys(
	sessionHandlers,
) as SessionHandledTypes;

export function getSessionStatements<K extends CanonicalEventType>(
	event: StoredEvent & { type: K; data: EventPayloadMap[K] },
	claudeWorktreeState?: string | null,
): readonly SessionStatement[] {
	// The partial view permits ignored event types while preserving the correlation
	// between each handler key and its payload through the generic K.
	const handlers: {
		readonly [T in CanonicalEventType]?: (
			event: StoredEvent & { type: T; data: EventPayloadMap[T] },
		) => readonly SessionStatement[];
	} = sessionHandlers;
	let statements = handlers[event.type]?.(event) ?? [];
	if (claudeWorktreeState !== undefined) {
		const fact: StoredEvent = event;
		const previous = claudeWorktreeState
			? decodeClaudeWorktreeState(claudeWorktreeState)
			: undefined;
		const next = projectClaudeWorktreeState(previous, event);
		const serialized = next === undefined ? null : JSON.stringify(next);
		if (
			fact.type === "session.workspace_changed" &&
			fact.data.cause === "agent" &&
			previous?.pending &&
			next?.observed !== previous.pending.path
		)
			statements = [];
		if (serialized !== claudeWorktreeState)
			statements = [
				...statements,
				{
					sql: "UPDATE sessions SET claude_worktree_state = ? WHERE id = ? AND claude_worktree_state IS NOT ?",
					params: [serialized, event.sessionId, serialized],
				},
			];
	}
	if (event.type !== "session.created" && event.type !== "session.forked") {
		return statements;
	}
	// A fork's own boundary copy is authoritative when already projected.
	// Claude forks reference the Source row; retain that captured fallback.
	return [
		...statements,
		{
			sql: `UPDATE sessions SET fork_point_timestamp = COALESCE(
			(SELECT created_at FROM messages
			 WHERE session_id = sessions.id AND id = sessions.fork_point_event),
			fork_point_timestamp, ?,
			(SELECT created_at FROM messages
			 WHERE session_id = sessions.forked_from AND id = sessions.fork_point_event)
		), fork_point_message_id = COALESCE(fork_point_message_id, ?, fork_point_event)
		WHERE id = ?`,
			params: [
				"forkPointTimestamp" in event.data &&
				typeof event.data.forkPointTimestamp === "number"
					? event.data.forkPointTimestamp
					: null,
				"forkPointMessageId" in event.data &&
				typeof event.data.forkPointMessageId === "string"
					? event.data.forkPointMessageId
					: null,
				event.sessionId,
			],
		},
	];
}
