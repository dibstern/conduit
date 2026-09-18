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
//     test/unit/persistence/session-removal-boundary-grep.test.ts allows
//     exactly one `DELETE FROM sessions` in the whole of src — the
//     REMOVE_SESSION_SQL declaration below — and allows it to be executed only
//     by the two projectors. Being inside this file buys nothing: a raw delete
//     here would be run as an ordinary write, with `RETURNING id` appended, and
//     would report the row it deleted while the cascade took the subtree in
//     silence. So a new delete path anywhere, inside the seam or outside it,
//     breaks the suite the moment it is written, with the fix named in the
//     failure message. The two deletes that legitimately sit outside —
//     retention eviction and the legacy skeleton migration — are listed there
//     with their reasons, and adding to that list is a deliberate act rather
//     than a silent one.
//
// Bead conduit-test-ni8.5.12.

import type {
	CanonicalEventType,
	EventPayloadMap,
	StoredEvent,
} from "../events.js";

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

type SessionHandledType =
	| "session.created"
	| "session.renamed"
	| "session.deleted"
	| "session.forked"
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
				sql: `INSERT INTO sessions (id, provider, provider_sid, title, status, parent_id, fork_point_event, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?)
					 ON CONFLICT (id) DO UPDATE SET
					     provider = CASE
					       WHEN EXISTS (
					         SELECT 1 FROM session_providers
					         WHERE session_id = sessions.id AND status = 'active'
					       )
					       THEN sessions.provider
					       WHEN sessions.provider NOT IN ('opencode', 'claude', 'claude-sdk')
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
				       THEN excluded.title
				       ELSE sessions.title
				     END,
				     parent_id = COALESCE(excluded.parent_id, sessions.parent_id),
				     fork_point_event = COALESCE(excluded.fork_point_event, sessions.fork_point_event),
				     updated_at = excluded.updated_at`,
				params: [
					event.data.sessionId,
					event.data.provider,
					event.data.providerSessionId ?? null,
					event.data.title,
					event.data.parentId ?? null,
					event.data.forkPointEvent ?? null,
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
		// children reachable through parent_id. The cascade keeps doing that; the
		// projector names the session subtree first so the removal can be
		// announced. See the note at the top of this file.
		return [{ removeSession: event.data.sessionId }];
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
	const statements = handlers[event.type]?.(event) ?? [];
	if (event.type !== "session.created" && event.type !== "session.forked") {
		return statements;
	}
	// Both projector implementations execute this writer before publishing the
	// session. Reads never need the parent message again.
	return [
		...statements,
		{
			sql: `UPDATE sessions SET fork_point_timestamp = COALESCE(
			fork_point_timestamp, ?,
			(SELECT created_at FROM messages
			 WHERE session_id = sessions.parent_id AND id = sessions.fork_point_event)
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
