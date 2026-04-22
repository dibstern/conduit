// src/lib/persistence/projectors/turn-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import { assertHandledOrIgnored, isEventType } from "./projector.js";

/** Event types that TurnProjector's project() method covers. */
const TURN_HANDLES = [
	"message.created",
	"session.status",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
] as const;

/**
 * Projects turn lifecycle events into the `turns` read-model table.
 *
 * A "turn" is one user-prompt -> assistant-response cycle. The turn ID is
 * the user message ID (the message that initiated the turn).
 *
 * Handled events:
 * - `message.created` (role=user)      -> INSERT turn, state=pending
 * - `message.created` (role=assistant)  -> UPDATE most recent turn with assistant_message_id
 * - `session.status` (status=busy)      -> UPDATE most recent pending turn to running
 * - `turn.completed`                    -> UPDATE matching turn to completed with cost/tokens
 * - `turn.error`                        -> UPDATE matching turn to error
 * - `turn.interrupted`                  -> UPDATE matching turn to interrupted
 */
export class TurnProjector implements Projector {
	readonly name = "turn";

	readonly handles: readonly CanonicalEventType[] = TURN_HANDLES;

	project(event: StoredEvent, db: SqliteClient): void {
		if (isEventType(event, "message.created")) {
			if (event.data.role === "user") {
				// User message creates a new turn
				db.execute(
					`INSERT OR REPLACE INTO turns
					 (id, session_id, state, user_message_id, requested_at)
					 VALUES (?, ?, 'pending', ?, ?)`,
					[
						event.data.messageId,
						event.data.sessionId,
						event.data.messageId,
						event.createdAt,
					],
				);
			} else {
				// Assistant message -- attach to the most recent turn in this session
				// that doesn't yet have an assistant_message_id. Use a sub-select
				// instead of UPDATE ... ORDER BY ... LIMIT to avoid depending on
				// the SQLITE_ENABLE_UPDATE_DELETE_LIMIT compile-time option.
				db.execute(
					`UPDATE turns
					 SET assistant_message_id = ?
					 WHERE id = (
					   SELECT id FROM turns
					   WHERE session_id = ?
					     AND assistant_message_id IS NULL
					     AND state IN ('pending', 'running')
					   ORDER BY requested_at DESC
					   LIMIT 1
					 )`,
					[event.data.messageId, event.data.sessionId],
				);
			}
			return;
		}

		if (isEventType(event, "session.status")) {
			if (event.data.status !== "busy") return;

			// Transition the most recent pending turn to running.
			db.execute(
				`UPDATE turns
				 SET state = 'running', started_at = ?
				 WHERE id = (
				   SELECT id FROM turns
				   WHERE session_id = ?
				     AND state = 'pending'
				   ORDER BY requested_at DESC
				   LIMIT 1
				 )`,
				[event.createdAt, event.data.sessionId],
			);
			return;
		}

		if (isEventType(event, "turn.completed")) {
			const tokens = event.data.tokens;
			db.execute(
				`UPDATE turns
				 SET state = 'completed',
				     cost = ?,
				     tokens_in = ?,
				     tokens_out = ?,
				     completed_at = ?
				 WHERE assistant_message_id = ?`,
				[
					event.data.cost ?? null,
					tokens?.input ?? null,
					tokens?.output ?? null,
					event.createdAt,
					event.data.messageId,
				],
			);
			return;
		}

		if (isEventType(event, "turn.error")) {
			db.execute(
				`UPDATE turns
				 SET state = 'error', completed_at = ?
				 WHERE assistant_message_id = ?`,
				[event.createdAt, event.data.messageId],
			);
			return;
		}

		if (isEventType(event, "turn.interrupted")) {
			db.execute(
				`UPDATE turns
				 SET state = 'interrupted', completed_at = ?
				 WHERE assistant_message_id = ?`,
				[event.createdAt, event.data.messageId],
			);
			return;
		}

		assertHandledOrIgnored(this, event);
	}
}
