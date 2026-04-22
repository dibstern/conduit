// src/lib/persistence/projectors/message-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { ProjectionContext, Projector } from "./projector.js";
import {
	assertHandledOrIgnored,
	encodeJson,
	isEventType,
} from "./projector.js";

/** Event types that MessageProjector's project() method covers. */
const MESSAGE_HANDLES = [
	"message.created",
	"text.delta",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
	"tool.started",
	"tool.running",
	"tool.completed",
	"turn.completed",
	"turn.error",
] as const;

/**
 * Projects message lifecycle events into the `messages` and `message_parts`
 * read-model tables.
 *
 * (P1) Normalized `message_parts` table eliminates the JSON
 * read-parse-modify-serialize-write cycle from the hot path. Per-delta
 * cost is 2 SQL statements with zero JSON:
 * 1. UPSERT on message_parts (SQL-native text || ? concat)
 * 2. UPDATE on messages.text (SQL-native text || ? concat)
 *
 * Handled events:
 * - `message.created`  -> INSERT message row with empty text, is_streaming=1
 * - `text.delta`       -> UPSERT message_parts row (SQL concat), UPDATE messages.text
 * - `thinking.start`   -> INSERT message_parts row with type=thinking
 * - `thinking.delta`   -> UPSERT message_parts row (SQL concat, no messages.text update)
 * - `thinking.end`     -> UPDATE messages.updated_at only
 * - `tool.started`     -> INSERT message_parts row with type=tool, ON CONFLICT DO NOTHING
 * - `tool.running`     -> UPDATE message_parts.status to running
 * - `tool.completed`   -> UPDATE message_parts with result, duration, status=completed
 * - `turn.completed`   -> Finalize: cost, tokens, is_streaming=0
 * - `turn.error`       -> Finalize: is_streaming=0
 *
 * (P3) Replay safety: The `alreadyApplied()` check is only needed for
 * the text.delta and thinking.delta SQL concat path (text || ? doubles on
 * replay), and only during recovery (replaying=true). During normal
 * streaming, events arrive in order and are never replayed.
 *
 * (Perf-Fix-1) sort_order is computed inline via COALESCE subquery in the
 * VALUES clause. This eliminates the separate db.queryOne() round-trip that
 * getNextSortOrder() required (~50 calls/sec during streaming).
 */
export class MessageProjector implements Projector {
	readonly name = "message";

	readonly handles: readonly CanonicalEventType[] = MESSAGE_HANDLES;

	project(event: StoredEvent, db: SqliteClient, ctx?: ProjectionContext): void {
		if (isEventType(event, "message.created")) {
			const isStreaming = event.data.role === "assistant" ? 1 : 0;
			db.execute(
				`INSERT INTO messages
				 (id, session_id, role, text, is_streaming, created_at, updated_at)
				 VALUES (?, ?, ?, '', ?, ?, ?)
				 ON CONFLICT (id) DO NOTHING`,
				[
					event.data.messageId,
					event.data.sessionId,
					event.data.role,
					isStreaming,
					event.createdAt,
					event.createdAt,
				],
			);
			return;
		}

		if (isEventType(event, "text.delta")) {
			// (P3) Only check during replay -- during normal streaming, events
			// arrive in order and are never replayed, so this SELECT is waste.
			if (
				ctx?.replaying &&
				this.alreadyApplied(db, event.data.messageId, event.sequence)
			)
				return;

			// Defensive: ensure the messages row exists before accumulating text.
			// The Claude adapter emits text.delta without a preceding message.created;
			// this INSERT OR IGNORE is a no-op when message.created arrived first.
			db.execute(
				`INSERT OR IGNORE INTO messages
				 (id, session_id, role, text, is_streaming, created_at, updated_at)
				 VALUES (?, ?, 'assistant', '', 1, ?, ?)`,
				[
					event.data.messageId,
					event.sessionId,
					event.createdAt,
					event.createdAt,
				],
			);

			// (P1, Perf-Fix-1) sort_order computed in SQL, not Node.js.
			db.execute(
				`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				 VALUES (?, ?, 'text', ?,
				     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
				     ?, ?)
				 ON CONFLICT (id) DO UPDATE SET
				     text = message_parts.text || excluded.text,
				     updated_at = excluded.updated_at`,
				[
					event.data.partId,
					event.data.messageId,
					event.data.text,
					event.data.messageId, // for the COALESCE subquery
					event.createdAt,
					event.createdAt,
				],
			);

			// Update the denormalized text column on the message
			db.execute(
				"UPDATE messages SET text = text || ?, last_applied_seq = ?, updated_at = ? WHERE id = ?",
				[
					event.data.text,
					event.sequence,
					event.createdAt,
					event.data.messageId,
				],
			);
			return;
		}

		if (isEventType(event, "thinking.start")) {
			// Defensive: ensure the messages row exists before inserting a thinking part.
			// The Claude adapter emits thinking.start without a preceding message.created;
			// this INSERT OR IGNORE is a no-op when message.created or text.delta arrived first.
			db.execute(
				`INSERT OR IGNORE INTO messages
				 (id, session_id, role, text, is_streaming, created_at, updated_at)
				 VALUES (?, ?, 'assistant', '', 1, ?, ?)`,
				[
					event.data.messageId,
					event.sessionId,
					event.createdAt,
					event.createdAt,
				],
			);
			// (Perf-Fix-1) sort_order computed in SQL, not Node.js.
			db.execute(
				`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				 VALUES (?, ?, 'thinking', '',
				     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
				     ?, ?)
				 ON CONFLICT (id) DO NOTHING`,
				[
					event.data.partId,
					event.data.messageId,
					event.data.messageId,
					event.createdAt,
					event.createdAt,
				],
			);
			db.execute("UPDATE messages SET updated_at = ? WHERE id = ?", [
				event.createdAt,
				event.data.messageId,
			]);
			return;
		}

		if (isEventType(event, "thinking.delta")) {
			// (P3) Only check during replay
			if (
				ctx?.replaying &&
				this.alreadyApplied(db, event.data.messageId, event.sequence)
			)
				return;

			// Defensive: ensure the messages row exists before inserting a thinking part.
			// Matches the defensive INSERT pattern used by text.delta / thinking.start /
			// tool.started for out-of-order delivery where the delta arrives before
			// message.created. Without this, the FK constraint on message_parts.message_id
			// fails. No-op when message.created (or a sibling defensive INSERT) arrived first.
			db.execute(
				`INSERT OR IGNORE INTO messages
				 (id, session_id, role, text, is_streaming, created_at, updated_at)
				 VALUES (?, ?, 'assistant', '', 1, ?, ?)`,
				[
					event.data.messageId,
					event.sessionId,
					event.createdAt,
					event.createdAt,
				],
			);

			// (Perf-Fix-1) sort_order computed in SQL, not Node.js.
			db.execute(
				`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				 VALUES (?, ?, 'thinking', ?,
				     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
				     ?, ?)
				 ON CONFLICT (id) DO UPDATE SET
				     text = message_parts.text || excluded.text,
				     updated_at = excluded.updated_at`,
				[
					event.data.partId,
					event.data.messageId,
					event.data.text,
					event.data.messageId,
					event.createdAt,
					event.createdAt,
				],
			);
			db.execute(
				"UPDATE messages SET last_applied_seq = ?, updated_at = ? WHERE id = ?",
				[event.sequence, event.createdAt, event.data.messageId],
			);
			return;
		}

		if (isEventType(event, "thinking.end")) {
			db.execute("UPDATE messages SET updated_at = ? WHERE id = ?", [
				event.createdAt,
				event.data.messageId,
			]);
			return;
		}

		if (isEventType(event, "tool.started")) {
			// Defensive: ensure the messages row exists before inserting a tool part.
			// The Claude adapter emits tool.started without a preceding message.created;
			// this INSERT OR IGNORE is a no-op when message.created or text.delta arrived first.
			db.execute(
				`INSERT OR IGNORE INTO messages
				 (id, session_id, role, text, is_streaming, created_at, updated_at)
				 VALUES (?, ?, 'assistant', '', 1, ?, ?)`,
				[
					event.data.messageId,
					event.sessionId,
					event.createdAt,
					event.createdAt,
				],
			);
			// (Perf-Fix-1) sort_order computed in SQL, not Node.js.
			db.execute(
				`INSERT INTO message_parts
				 (id, message_id, type, tool_name, call_id, input, status, sort_order, created_at, updated_at)
				 VALUES (?, ?, 'tool', ?, ?, ?, 'started',
				     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
				     ?, ?)
				 ON CONFLICT (id) DO NOTHING`,
				[
					event.data.partId,
					event.data.messageId,
					event.data.toolName,
					event.data.callId,
					encodeJson(event.data.input),
					event.data.messageId,
					event.createdAt,
					event.createdAt,
				],
			);
			db.execute("UPDATE messages SET updated_at = ? WHERE id = ?", [
				event.createdAt,
				event.data.messageId,
			]);
			return;
		}

		if (isEventType(event, "tool.running")) {
			// Final-state UPDATE -- naturally idempotent
			db.execute(
				"UPDATE message_parts SET status = 'running', updated_at = ? WHERE id = ?",
				[event.createdAt, event.data.partId],
			);
			db.execute("UPDATE messages SET updated_at = ? WHERE id = ?", [
				event.createdAt,
				event.data.messageId,
			]);
			return;
		}

		if (isEventType(event, "tool.completed")) {
			// Final-state UPDATE -- naturally idempotent
			db.execute(
				`UPDATE message_parts
				 SET result = ?, duration = ?, status = 'completed', updated_at = ?
				 WHERE id = ?`,
				[
					encodeJson(event.data.result),
					event.data.duration,
					event.createdAt,
					event.data.partId,
				],
			);
			db.execute("UPDATE messages SET updated_at = ? WHERE id = ?", [
				event.createdAt,
				event.data.messageId,
			]);
			return;
		}

		if (isEventType(event, "turn.completed")) {
			const tokens = event.data.tokens;
			db.execute(
				`UPDATE messages SET
				 cost = ?,
				 tokens_in = ?,
				 tokens_out = ?,
				 tokens_cache_read = ?,
				 tokens_cache_write = ?,
				 is_streaming = 0,
				 updated_at = ?
				 WHERE id = ?`,
				[
					event.data.cost ?? null,
					tokens?.input ?? null,
					tokens?.output ?? null,
					tokens?.cacheRead ?? null,
					tokens?.cacheWrite ?? null,
					event.createdAt,
					event.data.messageId,
				],
			);
			return;
		}

		if (isEventType(event, "turn.error")) {
			db.execute(
				"UPDATE messages SET is_streaming = 0, updated_at = ? WHERE id = ?",
				[event.createdAt, event.data.messageId],
			);
			return;
		}

		// Runtime guard: throws if event.type is in `handles` but not covered above
		assertHandledOrIgnored(this, event);
	}

	// ─── Private helpers ──────────────────────────────────────────────────

	/**
	 * Check if this event sequence has already been applied to this message.
	 *
	 * Delta events (text.delta, thinking.delta) are NOT naturally idempotent --
	 * replaying them appends text again via SQL concat, doubling content.
	 * We track the last-applied sequence per message in the `last_applied_seq`
	 * column and skip events that have already been applied.
	 *
	 * (P3) Only called during replay (ctx.replaying=true). During normal
	 * streaming, this SELECT is skipped entirely.
	 */
	private alreadyApplied(
		db: SqliteClient,
		messageId: string,
		sequence: number,
	): boolean {
		const row = db.queryOne<{ last_applied_seq: number | null }>(
			"SELECT last_applied_seq FROM messages WHERE id = ?",
			[messageId],
		);
		if (!row) return false; // message doesn't exist yet
		return row.last_applied_seq != null && sequence <= row.last_applied_seq;
	}
}
