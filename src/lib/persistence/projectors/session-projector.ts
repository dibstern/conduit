// src/lib/persistence/projectors/session-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import {
	getSessionStatements,
	SESSION_HANDLED_TYPES,
} from "./session-handlers.js";

/**
 * Projects session lifecycle events into the `sessions` read-model table.
 *
 * Handled events:
 * - `session.created`         -> INSERT with ON CONFLICT DO UPDATE (only replacing default placeholder titles)
 * - `session.renamed`         -> UPDATE title
 * - `session.deleted`         -> DELETE session read-model rows
 * - `session.status`          -> UPDATE status
 * - `session.provider_changed`-> UPDATE provider
 * - `turn.completed`          -> UPDATE updated_at only
 * - `turn.error`              -> UPDATE updated_at only
 * - `message.created`         -> UPDATE last_message_at (P8 -- denormalized for efficient ordering)
 */
export class SessionProjector implements Projector {
	readonly name = "session";

	readonly handles: readonly CanonicalEventType[] = SESSION_HANDLED_TYPES;

	project(event: StoredEvent, db: SqliteClient): void {
		for (const stmt of getSessionStatements(event)) {
			db.execute(stmt.sql, [...stmt.params]);
		}
	}
}
