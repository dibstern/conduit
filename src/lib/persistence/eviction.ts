import type { Logger } from "../logger.js";
import type { SqliteClient } from "./sqlite-client.js";

export interface EvictionOptions {
	/** How old a session must be (ms) before its events are evicted. Default: 7 days. */
	retentionMs?: number;
	/** Max rows to delete per batch. Default: 5000. */
	batchSize?: number;
	/** Callback invoked between batches (for yielding the event loop). */
	onYield?: () => void;
}

export interface EvictionResult {
	eventsDeleted: number;
	receiptsDeleted: number;
	batchesExecuted: number;
	/** Number of sessions whose projection tables were cascade-deleted. */
	sessionsCascaded?: number;
}

/**
 * Age-based event store eviction with batched deletes.
 *
 * Identifies stale sessions (idle + older than retention period) via the
 * sessions table index, then deletes their events in batches to avoid
 * blocking the event loop. Projection rows (sessions, messages, turns,
 * message_parts) remain queryable after event eviction. Call
 * `cascadeProjections()` to also delete projection rows for fully-evicted
 * sessions.
 *
 * Two modes:
 * - `evictSync()`: Batched DELETE in a loop. Each batch is a separate
 *   transaction. Suitable for moderate-size stores (<100K events).
 * - `evictAsync()`: Same batched DELETE but `await`s a `setImmediate`
 *   between batches, yielding the event loop. Use for large stores.
 *
 * VACUUM is intentionally omitted from the public API. It rewrites the
 * entire database file synchronously and should only be run from a CLI
 * command or worker thread, never during normal daemon operation.
 */
export class EventStoreEviction {
	private readonly db: SqliteClient;
	private readonly log?: Logger;

	constructor(db: SqliteClient, log?: Logger) {
		this.db = db;
		if (log) this.log = log;
	}

	/**
	 * Synchronous batched eviction. Blocks the event loop only for
	 * `batchSize` rows at a time (~1-5ms per batch of 5000 rows).
	 */
	evictSync(opts?: EvictionOptions): EvictionResult {
		const retentionMs = opts?.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
		const batchSize = opts?.batchSize ?? 5000;
		const cutoff = Date.now() - retentionMs;

		let totalEventsDeleted = 0;
		let batchesExecuted = 0;

		// Batched event deletion — each batch is its own implicit transaction
		while (true) {
			const result = this.db.execute(
				`DELETE FROM events WHERE sequence IN (
					SELECT events.sequence FROM events
					JOIN sessions ON events.session_id = sessions.id
					WHERE sessions.status = 'idle'
					  AND sessions.updated_at < ?
					LIMIT ?
				)`,
				[cutoff, batchSize],
			);

			const deleted = Number(result.changes);
			totalEventsDeleted += deleted;
			batchesExecuted++;

			if (deleted < batchSize) break; // last batch
		}

		// Command receipts cleanup (single pass — typically small table)
		const receiptsResult = this.db.execute(
			"DELETE FROM command_receipts WHERE created_at < ?",
			[cutoff],
		);
		const receiptsDeleted = Number(receiptsResult.changes);

		if (totalEventsDeleted > 0 || receiptsDeleted > 0) {
			this.log?.info("eviction complete", {
				eventsDeleted: totalEventsDeleted,
				receiptsDeleted,
				batchesExecuted,
				cutoff: new Date(cutoff).toISOString(),
			});
		}

		return {
			eventsDeleted: totalEventsDeleted,
			receiptsDeleted,
			batchesExecuted,
		};
	}

	/**
	 * Async batched eviction. Yields the event loop between batches via
	 * `setImmediate`, allowing WebSocket/HTTP handlers to run.
	 */
	async evictAsync(opts?: EvictionOptions): Promise<EvictionResult> {
		const retentionMs = opts?.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
		const batchSize = opts?.batchSize ?? 5000;
		const onYield = opts?.onYield;
		const cutoff = Date.now() - retentionMs;

		let totalEventsDeleted = 0;
		let batchesExecuted = 0;

		while (true) {
			const result = this.db.execute(
				`DELETE FROM events WHERE sequence IN (
					SELECT events.sequence FROM events
					JOIN sessions ON events.session_id = sessions.id
					WHERE sessions.status = 'idle'
					  AND sessions.updated_at < ?
					LIMIT ?
				)`,
				[cutoff, batchSize],
			);

			const deleted = Number(result.changes);
			totalEventsDeleted += deleted;
			batchesExecuted++;

			if (deleted < batchSize) break;

			// Yield the event loop
			onYield?.();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		const receiptsResult = this.db.execute(
			"DELETE FROM command_receipts WHERE created_at < ?",
			[cutoff],
		);
		const receiptsDeleted = Number(receiptsResult.changes);

		if (totalEventsDeleted > 0 || receiptsDeleted > 0) {
			this.log?.info("eviction complete", {
				eventsDeleted: totalEventsDeleted,
				receiptsDeleted,
				batchesExecuted,
				cutoff: new Date(cutoff).toISOString(),
			});
		}

		return {
			eventsDeleted: totalEventsDeleted,
			receiptsDeleted,
			batchesExecuted,
		};
	}

	// ── S5: Cascade Eviction for Projection Tables ─────────────────────

	/**
	 * Cascade through projection tables for sessions with zero remaining
	 * events. Call after evictSync/evictAsync completes.
	 *
	 * Only deletes projection rows when ALL conditions are met:
	 * 1. All events for the session have been evicted (zero remaining)
	 * 2. Session is idle
	 * 3. Session is older than the retention period
	 *
	 * Deletes in FK-safe order. Batches session deletions (100 per
	 * transaction) to avoid blocking.
	 */
	cascadeProjections(opts?: {
		retentionMs?: number;
		batchSize?: number;
	}): number {
		const retentionMs = opts?.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
		const batchSize = opts?.batchSize ?? 100;
		const cutoff = Date.now() - retentionMs;

		// Find sessions with zero remaining events that are idle and old
		const staleSessions = this.db.query<{ id: string }>(
			`SELECT s.id FROM sessions s
			 LEFT JOIN events e ON e.session_id = s.id
			 WHERE s.status = 'idle'
			   AND s.updated_at < ?
			 GROUP BY s.id
			 HAVING COUNT(e.sequence) = 0`,
			[cutoff],
		);

		if (staleSessions.length === 0) return 0;

		let totalCascaded = 0;

		// Process in batches of batchSize sessions per transaction
		for (let i = 0; i < staleSessions.length; i += batchSize) {
			const batch = staleSessions.slice(i, i + batchSize);
			const ids = batch.map((s) => s.id);

			this.db.runInTransaction(() => {
				for (const sessionId of ids) {
					// FK-safe cascade order:
					this.db.execute("DELETE FROM activities WHERE session_id = ?", [
						sessionId,
					]);
					this.db.execute(
						"DELETE FROM pending_approvals WHERE session_id = ?",
						[sessionId],
					);
					this.db.execute(
						"DELETE FROM message_parts WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)",
						[sessionId],
					);
					this.db.execute("DELETE FROM messages WHERE session_id = ?", [
						sessionId,
					]);
					this.db.execute("DELETE FROM turns WHERE session_id = ?", [
						sessionId,
					]);
					this.db.execute(
						"DELETE FROM session_providers WHERE session_id = ?",
						[sessionId],
					);
					this.db.execute("DELETE FROM tool_content WHERE session_id = ?", [
						sessionId,
					]);
					this.db.execute("DELETE FROM provider_state WHERE session_id = ?", [
						sessionId,
					]);
					this.db.execute("DELETE FROM sessions WHERE id = ?", [sessionId]);

					totalCascaded++;
				}
			});
		}

		if (totalCascaded > 0) {
			this.log?.info("cascade eviction complete", {
				sessionsCascaded: totalCascaded,
				cutoff: new Date(cutoff).toISOString(),
			});
		}

		return totalCascaded;
	}
}
