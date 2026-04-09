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

/**
 * Projects session lifecycle events into the `sessions` read-model table.
 *
 * Handled events:
 * - `session.created`         -> INSERT with ON CONFLICT DO UPDATE (preserving nullable columns)
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
			// to preserve nullable columns (provider_sid, parent_id,
			// fork_point_event) that may have been set by other code paths.
			db.execute(
				`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'idle', ?, ?)
				 ON CONFLICT (id) DO UPDATE SET
				     provider = excluded.provider,
				     title = excluded.title,
				     updated_at = excluded.updated_at`,
				[
					event.data.sessionId,
					event.data.provider,
					event.data.title,
					event.createdAt,
					event.createdAt,
				],
			);
			return;
		}

		if (isEventType(event, "session.renamed")) {
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
