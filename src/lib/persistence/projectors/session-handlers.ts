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
	| "session.deleted"
	| "session.status"
	| "session.provider_changed"
	| "session.permission_mode_changed"
	| "turn.completed"
	| "turn.error"
	| "message.created";

function isAutoTitleRename(event: StoredEvent): boolean {
	return event.metadata.source === "auto-title";
}

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

	"session.status": (event) => {
		return [
			{
				sql: "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
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
			{
				sql: "UPDATE sessions SET updated_at = ? WHERE id = ?",
				params: [event.createdAt, event.sessionId],
			},
		];
	},
	"turn.error": (event) => {
		return [
			{
				sql: "UPDATE sessions SET updated_at = ? WHERE id = ?",
				params: [event.createdAt, event.sessionId],
			},
		];
	},

	// (P8) Denormalize last_message_at on the session. Owned by
	// SessionProjector (not MessageProjector) to keep all session-table
	// mutations in one projector.
	"message.created": (event) => {
		return [
			{
				sql: `UPDATE sessions SET
					last_message_at = MAX(COALESCE(last_message_at, 0), ?),
					updated_at = ?
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
