import type {
	CanonicalEventType,
	EventPayloadMap,
	StoredEvent,
} from "../events.js";

export interface SessionStatement {
	readonly sql: string;
	readonly params: readonly (string | number | null)[];
}

type SessionHandledType =
	| "session.created"
	| "session.renamed"
	| "session.read"
	| "session.unread"
	| "session.settled"
	| "session.unsettled"
	| "session.pinned"
	| "session.unpinned"
	| "session.snoozed"
	| "session.unsnoozed"
	| "session.deleted"
	| "session.forked"
	| "session.status"
	| "session.provider_changed"
	| "session.permission_mode_changed"
	| "turn.completed"
	| "turn.error"
	| "permission.asked"
	| "question.asked"
	| "message.created";

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

function isAutoTitleRename(event: StoredEvent): boolean {
	return event.metadata.source === "auto-title";
}

// last_turn_error_at answers one durable question rather than mirroring the
// turn state machine: failures set it, while success or new work clears it.
//
// This mapped table replaces SessionProjector's assertHandledOrIgnored runtime
// guard: every SessionHandledType must have an implementation at compile time.
// Other projectors still use assertHandledOrIgnored for their imperative branches.
export const sessionHandlers: {
	readonly [K in SessionHandledType]: (
		event: StoredEvent & { type: K; data: EventPayloadMap[K] },
	) => readonly SessionStatement[];
} = {
	"session.created": (event) => {
		// Use INSERT ... ON CONFLICT DO UPDATE instead of INSERT OR REPLACE
		// to preserve user/auto-renamed titles plus nullable columns
		// (provider_sid, parent_id, fork_point_event) that may have been set by
		// other code paths.
		return [
			{
				sql: `INSERT INTO sessions (id, provider, provider_sid, title, status, parent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'idle', ?, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET
				     provider = excluded.provider,
				     provider_sid = COALESCE(excluded.provider_sid, sessions.provider_sid),
				     title = CASE
				       WHEN sessions.title IS NULL
				         OR sessions.title = ''
				         OR sessions.title IN ('Untitled', 'Claude Session', 'Test Session')
				         OR sessions.title LIKE 'New session%'
				         OR sessions.parent_id IS NOT NULL
				         OR excluded.parent_id IS NOT NULL
				       THEN excluded.title
				       ELSE sessions.title
				     END,
				     parent_id = COALESCE(excluded.parent_id, sessions.parent_id),
				     updated_at = excluded.updated_at`,
				params: [
					event.data.sessionId,
					event.data.provider,
					event.data.providerSessionId ?? null,
					event.data.title,
					event.data.parentId ?? null,
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
					   AND provider IN ('claude', 'claude-sdk')
					   AND NOT EXISTS (
					     SELECT 1
					     FROM events prior
					     WHERE prior.session_id = ?
					       AND prior.type = 'session.renamed'
					       AND prior.sequence < ?
					       AND COALESCE(json_extract(prior.metadata, '$.source'), '') <> 'auto-title'
					   )
					   AND (
					     title IS NULL
					     OR TRIM(title) = ''
					     OR LOWER(TRIM(title)) IN ('claude session', 'untitled', 'new session')
					     OR LOWER(TRIM(title)) LIKE 'new session %'
					   )`,
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
		return [
			{
				sql: "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
				params: [event.data.title, event.createdAt, event.data.sessionId],
			},
		];
	},

	// Last transition wins, and these need no guard against an earlier one
	// overwriting a later one: every replay path is ORDER BY sequence ASC, so the
	// events arrive in the order they happened. The lookahead subquery this
	// briefly had was pure cost. Deliberately does NOT touch `updated_at` --
	// that is the list's sort key, so reading a session must not reorder it.
	"session.read": (event) => [
		{
			sql: "UPDATE sessions SET read_at = ? WHERE id = ?",
			// The event's own timestamp, never Date.now(): the same log has to
			// project to the same table every time.
			params: [event.createdAt, event.data.sessionId],
		},
	],

	"session.unread": (event) => [
		{
			sql: "UPDATE sessions SET read_at = NULL WHERE id = ?",
			params: [event.data.sessionId],
		},
	],

	"session.settled": (event) => [
		{
			sql: "UPDATE sessions SET settled_at = ? WHERE id = ?",
			params: [event.createdAt, event.data.sessionId],
		},
	],

	"session.unsettled": (event) => [
		{
			sql: "UPDATE sessions SET settled_at = NULL WHERE id = ?",
			params: [event.data.sessionId],
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
		// children reachable through parent_id.
		return [
			{
				sql: "DELETE FROM sessions WHERE id = ?",
				params: [event.data.sessionId],
			},
		];
	},

	// Lineage only. The row itself is brought into being by session.created —
	// upstream for OpenCode forks, which is why this is an UPDATE and not an
	// upsert: this handler has no title or provider to insert with.
	"session.forked": (event) => {
		return [
			{
				sql: `UPDATE sessions SET
					parent_id = ?,
					fork_point_event = COALESCE(?, fork_point_event),
					updated_at = ?
				 WHERE id = ?`,
				params: [
					event.data.parentId,
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

	"turn.completed": (event) => {
		return [
			wakeSession(event.sessionId, event.createdAt, "turn"),
			{
				sql: "UPDATE sessions SET updated_at = ?, last_turn_error_at = NULL WHERE id = ?",
				params: [event.createdAt, event.sessionId],
			},
		];
	},
	"turn.error": (event) => {
		return [
			wakeSession(event.sessionId, event.createdAt, "error"),
			{
				sql: "UPDATE sessions SET updated_at = ?, last_turn_error_at = ? WHERE id = ?",
				params: [event.createdAt, event.createdAt, event.sessionId],
			},
		];
	},
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
					updated_at = ?${startsNewTurn ? ",\n\t\t\t\t\tlast_turn_error_at = NULL" : ""}
				 WHERE id = ?`,
				params: [event.createdAt, event.createdAt, event.data.sessionId],
			},
		];
	},
};

export const SESSION_HANDLED_TYPES = Object.keys(
	sessionHandlers,
) as readonly SessionHandledType[];

export function getSessionStatements<K extends CanonicalEventType>(
	event: StoredEvent & { type: K; data: EventPayloadMap[K] },
): readonly SessionStatement[] {
	// The partial view permits ignored event types while preserving the correlation
	// between each handler key and its payload through the generic K.
	const handlers: {
		readonly [T in CanonicalEventType]?: (
			event: StoredEvent & { type: T; data: EventPayloadMap[T] },
		) => readonly SessionStatement[];
	} = sessionHandlers;
	return handlers[event.type]?.(event) ?? [];
}
