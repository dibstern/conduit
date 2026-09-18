// src/lib/persistence/projectors/turn-projector.ts
import { persistedTurnState } from "../../contracts/turn-phase.js";
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import { assertHandledOrIgnored, isEventType } from "./projector.js";

/** Event types that TurnProjector's project() method covers. */
const TURN_HANDLES = [
	"message.created",
	"tool.started",
	"session.status",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"turn.model_resolved",
] as const;

/**
 * Projects turn lifecycle events into the `turns` read-model table.
 *
 * A "turn" is one user-prompt -> assistant-response cycle. The turn ID is
 * the user message ID (the message that initiated the turn).
 *
 * Handled events:
 * - `message.created` (role=user)      -> INSERT turn, state=pending
 * - `message.created` (role=assistant)  -> UPDATE newest turn to running and attach assistant_message_id
 * - `tool.started`                     -> UPDATE newest turn to running
 * - `session.status` (status=busy)      -> UPDATE newest turn to running
 * - `turn.completed`                    -> UPDATE matching turn to completed with cost/tokens
 * - `turn.error`                        -> UPDATE matching turn to error
 * - `turn.interrupted`                  -> UPDATE matching turn to interrupted
 */
export class TurnProjector implements Projector {
	readonly name = "turn";

	readonly handles: readonly CanonicalEventType[] = TURN_HANDLES;

	project(event: StoredEvent, db: SqliteClient): void {
		if (isEventType(event, "message.created") && event.data.role === "user") {
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
			return;
		}

		// Unambiguous new work: a provider can report a result and keep going,
		// so any of these after a settle means the turn is running again.
		// Deltas and tool progress/metadata updates are deliberately absent —
		// they add nothing the signals below miss, they fire on every token,
		// and a late update to an already-closed tool must not reopen a turn.
		if (
			(isEventType(event, "session.status") && event.data.status === "busy") ||
			isEventType(event, "message.created") ||
			isEventType(event, "tool.started")
		) {
			const turn = db.queryOne<{
				id: string;
				state: string;
				assistant_message_id: string | null;
			}>(
				`SELECT id, state, assistant_message_id FROM turns
				 WHERE session_id = ?
				 ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
				[event.sessionId],
			);
			if (!turn) return;
			const reopening = turn.state !== "pending" && turn.state !== "running";
			const assistantMessageId = reopening ? null : turn.assistant_message_id;
			db.execute(
				`UPDATE turns
				 SET state = ?,
				     started_at = COALESCE(started_at, ?),
				     completed_at = NULL,
				     assistant_message_id = ?
				 WHERE id = ?`,
				[
					persistedTurnState(
						event.type === "session.status" ? "busy" : "activity",
					),
					event.createdAt,
					isEventType(event, "message.created")
						? (assistantMessageId ?? event.data.messageId)
						: assistantMessageId,
					turn.id,
				],
			);
			return;
		}

		if (isEventType(event, "session.status")) return;

		if (isEventType(event, "turn.completed")) {
			// Cost and tokens are counted differently by the provider, which
			// reads like a bug and is not: cost is cumulative for the whole
			// SDK session (two completions in one turn read 38.53 then 39.84),
			// so the latest value wins. Tokens are per-execution, so a turn
			// that ran twice sums them.
			const tokens = event.data.tokens;
			db.execute(
				`UPDATE turns
				 SET state = ?,
				     cost = COALESCE(?, cost),
				     tokens_in = COALESCE(tokens_in + ?, tokens_in, ?),
				     tokens_out = COALESCE(tokens_out + ?, tokens_out, ?),
				     completed_at = ?
				 WHERE assistant_message_id = ?`,
				[
					persistedTurnState("result"),
					event.data.cost ?? null,
					tokens?.input ?? null,
					tokens?.input ?? null,
					tokens?.output ?? null,
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
				 SET state = ?, completed_at = ?
				 WHERE assistant_message_id = ?`,
				[persistedTurnState("error"), event.createdAt, event.data.messageId],
			);
			return;
		}

		if (isEventType(event, "turn.interrupted")) {
			const { changes } = db.execute(
				`UPDATE turns
				 SET state = ?, completed_at = ?
				 WHERE assistant_message_id = ?`,
				[
					persistedTurnState("interrupt"),
					event.createdAt,
					event.data.messageId,
				],
			);
			if (Number(changes) === 0) {
				// Interrupts emitted from provider cleanup may carry a messageId
				// that never matched an assistant message (or none at all, when
				// the turn was cut before the assistant reply started). Fall back
				// to closing the most recent still-open turn so it can't stay
				// 'running' forever.
				db.execute(
					`UPDATE turns
					 SET state = ?, completed_at = ?
					 WHERE id = (
					   SELECT id FROM turns
					   WHERE session_id = ?
					     AND state IN ('pending', 'running')
					   ORDER BY requested_at DESC
					   LIMIT 1
					 )`,
					[persistedTurnState("interrupt"), event.createdAt, event.sessionId],
				);
			}
			return;
		}

		// Attributed to the newest open turn rather than by id, because the event
		// carries no key that reaches a turns row: turns.id is the user message
		// id, while the provider's turnId is a per-send uuid. This is exact only
		// while a session has at most one turn in flight. The Claude translator
		// is the sole emitter and its runtime serializes turn admission, so a
		// turn's model_resolved always lands before the next turn's row exists.
		// A second emitter, or concurrent turns, needs a real key first — see
		// conduit-test-7i3.
		if (isEventType(event, "turn.model_resolved")) {
			db.execute(
				`UPDATE turns
				 SET requested_model = ?,
				     expected_model = ?,
				     actual_model = ?
				 WHERE id = (
				   SELECT id FROM turns
				   WHERE session_id = ?
				     AND state IN ('pending', 'running')
				   ORDER BY requested_at DESC
				   LIMIT 1
				 )`,
				[
					event.data.requestedModel ?? null,
					event.data.expectedModel ?? null,
					event.data.actualModel,
					event.sessionId,
				],
			);
			return;
		}

		assertHandledOrIgnored(this, event);
	}
}
