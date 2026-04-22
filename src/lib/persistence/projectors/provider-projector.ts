// src/lib/persistence/projectors/provider-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import { assertHandledOrIgnored, isEventType } from "./projector.js";

/**
 * Projects session-provider binding events into the `session_providers`
 * read-model table.
 *
 * Each row represents one session <-> provider binding with an activation
 * window. At most one binding per session has `status = 'active'` at any
 * point in time.
 *
 * Handled events:
 * - `session.created`           -> INSERT active binding with the initial provider
 * - `session.provider_changed`  -> Deactivate old binding, INSERT new active binding
 *
 * Idempotency for replay:
 * - `session.created`: uses deterministic ID `${sessionId}:initial` and
 *   `INSERT OR IGNORE`, so replays never create duplicates even after a
 *   `provider_changed` has stopped the initial binding.
 * - `session.provider_changed`: uses deterministic ID
 *   `${sessionId}:${event.sequence}` for the new binding (also
 *   `INSERT OR IGNORE`), and deactivation is idempotent
 *   (UPDATE ... WHERE status = 'active').
 */
export class ProviderProjector implements Projector {
	readonly name = "provider";

	readonly handles: readonly CanonicalEventType[] = [
		"session.created",
		"session.provider_changed",
	] as const;

	project(event: StoredEvent, db: SqliteClient): void {
		if (isEventType(event, "session.created")) {
			// Deterministic ID for the initial binding. `INSERT OR IGNORE`
			// keeps this idempotent across replays, even if a subsequent
			// `provider_changed` has already stopped the initial binding.
			db.execute(
				`INSERT OR IGNORE INTO session_providers (id, session_id, provider, status, activated_at)
				 VALUES (?, ?, ?, 'active', ?)`,
				[
					`${event.data.sessionId}:initial`,
					event.data.sessionId,
					event.data.provider,
					event.createdAt,
				],
			);
			return;
		}

		if (isEventType(event, "session.provider_changed")) {
			// Deactivate any currently-active binding for this session.
			db.execute(
				`UPDATE session_providers
				 SET status = 'stopped', deactivated_at = ?
				 WHERE session_id = ? AND status = 'active'`,
				[event.createdAt, event.data.sessionId],
			);

			// Insert new active binding with deterministic ID tied to the
			// event sequence so replays are idempotent.
			db.execute(
				`INSERT OR IGNORE INTO session_providers (id, session_id, provider, status, activated_at)
				 VALUES (?, ?, ?, 'active', ?)`,
				[
					`${event.data.sessionId}:${event.sequence}`,
					event.data.sessionId,
					event.data.newProvider,
					event.createdAt,
				],
			);
			return;
		}

		assertHandledOrIgnored(this, event);
	}
}
