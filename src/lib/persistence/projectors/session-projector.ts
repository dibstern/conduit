// src/lib/persistence/projectors/session-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import { assertHandledOrIgnored, isEventType } from "./projector.js";

/** Event types that SessionProjector's project() method covers. */
const SESSION_HANDLES = [
	"session.created",
	"session.renamed",
	"session.status",
	"session.provider_changed",
	"turn.completed",
	"turn.error",
	"message.created",
] as const;

function isAutoTitleRename(event: StoredEvent): boolean {
	return event.metadata.source === "auto-title";
}

/**
 * Projects session lifecycle events into the `sessions` read-model table.
 *
 * Handled events:
 * - `session.created`         -> INSERT with ON CONFLICT DO UPDATE (only replacing default placeholder titles)
 * - `session.renamed`         -> UPDATE title
 * - `session.status`          -> UPDATE status
 * - `session.provider_changed`-> UPDATE provider
 * - `turn.completed`          -> UPDATE updated_at only
 * - `turn.error`              -> UPDATE updated_at only
 * - `message.created`         -> UPDATE last_message_at (P8 -- denormalized for efficient ordering)
 */
export class SessionProjector implements Projector {
	readonly name = "session";

	readonly handles: readonly CanonicalEventType[] = SESSION_HANDLES;

	project(event: StoredEvent, db: SqliteClient): void {
		if (isEventType(event, "session.created")) {
			// Use INSERT ... ON CONFLICT DO UPDATE instead of INSERT OR REPLACE
			// to preserve user/auto-renamed titles plus nullable columns
			// (provider_sid, parent_id, fork_point_event) that may have been set by
			// other code paths.
			db.execute(
				`INSERT INTO sessions (id, provider, provider_sid, title, status, parent_id, created_at, updated_at)
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
				[
					event.data.sessionId,
					event.data.provider,
					event.data.providerSessionId ?? null,
					event.data.title,
					event.data.parentId ?? null,
					event.createdAt,
					event.createdAt,
				],
			);
			return;
		}

		if (isEventType(event, "session.renamed")) {
			if (isAutoTitleRename(event)) {
				db.execute(
					`UPDATE sessions SET title = ?, updated_at = ?
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
					[
						event.data.title,
						event.createdAt,
						event.data.sessionId,
						event.data.sessionId,
						event.sequence,
					],
				);
				return;
			}
			db.execute("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", [
				event.data.title,
				event.createdAt,
				event.data.sessionId,
			]);
			return;
		}

		if (isEventType(event, "session.status")) {
			db.execute(
				"UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
				[event.data.status, event.createdAt, event.data.sessionId],
			);
			return;
		}

		if (isEventType(event, "session.provider_changed")) {
			db.execute(
				"UPDATE sessions SET provider = ?, updated_at = ? WHERE id = ?",
				[event.data.newProvider, event.createdAt, event.data.sessionId],
			);
			return;
		}

		if (
			isEventType(event, "turn.completed") ||
			isEventType(event, "turn.error")
		) {
			db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", [
				event.createdAt,
				event.sessionId,
			]);
			return;
		}

		// (P8) Denormalize last_message_at on the session. Owned by
		// SessionProjector (not MessageProjector) to keep all session-table
		// mutations in one projector.
		if (isEventType(event, "message.created")) {
			db.execute(
				`UPDATE sessions SET
					last_message_at = MAX(COALESCE(last_message_at, 0), ?),
					updated_at = ?
				 WHERE id = ?`,
				[event.createdAt, event.createdAt, event.data.sessionId],
			);
			return;
		}

		// Runtime guard: throws if event.type is in `handles` but not covered above
		assertHandledOrIgnored(this, event);
	}
}
