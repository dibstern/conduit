// src/lib/persistence/projection-runner.ts

import { formatErrorDetail } from "../errors.js";
import type { Logger } from "../logger.js";
import { PersistenceError } from "./errors.js";
import type { EventStore } from "./event-store.js";
import type { CanonicalEventType, StoredEvent } from "./events.js";
import { CANONICAL_EVENT_TYPES } from "./events.js";
import type { ProjectorCursorRepository } from "./projector-cursor-repository.js";
import { ActivityProjector } from "./projectors/activity-projector.js";
import { ApprovalProjector } from "./projectors/approval-projector.js";
import { MessageProjector } from "./projectors/message-projector.js";
import type { Projector } from "./projectors/projector.js";
import { ProviderProjector } from "./projectors/provider-projector.js";
import { SessionProjector } from "./projectors/session-projector.js";
import { TurnProjector } from "./projectors/turn-projector.js";
import type { SqliteClient } from "./sqlite-client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A record of a projector failure, retained for diagnostics.
 *
 * When an LLM sees "projector is lagging", it can inspect `getFailures()`
 * to find the exact event, error, and projector that's stuck.
 */
export interface ProjectionFailure {
	readonly projectorName: string;
	readonly eventSequence: number;
	readonly eventType: string;
	readonly sessionId: string;
	readonly error: string;
	readonly errorCode: string | undefined;
	readonly failedAt: number;
}

export interface ProjectionRunnerConfig {
	readonly db: SqliteClient;
	readonly eventStore: EventStore;
	readonly cursorRepo: ProjectorCursorRepository;
	readonly projectors: readonly Projector[];
	readonly log?: Logger;
	/** (Perf-Fix-4) Batch size for async recovery. Defaults to 500. */
	readonly recoveryBatchSize?: number;
}

// ─── Recovery result types ───────────────────────────────────────────────────

/**
 * (A3) Structured result returned from `recover()` for diagnostics.
 * Callers and diagnostic tools can inspect what happened during recovery
 * without parsing log output.
 */
export interface RecoveryResult {
	readonly startCursor: number;
	readonly endCursor: number;
	readonly totalReplayed: number;
	readonly batchCount: number;
	readonly durationMs: number;
	readonly projectorCursors: readonly {
		projectorName: string;
		lastAppliedSeq: number;
		updatedAt: number;
	}[];
}

/** (P7) Per-projector recovery result for diagnostics. */
export interface ProjectorRecoveryResult {
	readonly projectorName: string;
	readonly startCursor: number;
	readonly endCursor: number;
	readonly eventsReplayed: number;
	readonly batchCount: number;
	readonly durationMs: number;
}

// (Perf-Fix-4) Async recovery types ──────────────────────────────────────────

export interface RecoveryProgress {
	projectorName: string;
	eventsReplayed: number;
	totalEstimated: number;
	durationMs: number;
}

export interface AsyncRecoveryOptions {
	onProgress?: (progress: RecoveryProgress) => void;
}

export interface AsyncRecoveryResult {
	totalReplayed: number;
	durationMs: number;
	perProjector: ProjectorRecoveryResult[];
}

/** Row shape returned by event queries (for recovery). */
interface EventRow {
	sequence: number;
	event_id: string;
	session_id: string;
	stream_version: number;
	type: string;
	data: string;
	metadata: string;
	provider: string;
	created_at: number;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates all 6 projectors in the correct order.
 *
 * Order matters for FK compliance: `SessionProjector` must run before
 * `MessageProjector`, `TurnProjector`, `ProviderProjector`, etc.
 * since they INSERT rows referencing `sessions(id)`.
 */
export function createAllProjectors(): Projector[] {
	return [
		new SessionProjector(),
		new MessageProjector(),
		new TurnProjector(),
		new ProviderProjector(),
		new ApprovalProjector(),
		new ActivityProjector(),
	];
}

// ─── ProjectionRunner ────────────────────────────────────────────────────────

/**
 * Orchestrates projection of canonical events through all registered projectors.
 *
 * Analogous to t3code's `ProjectionPipeline` — for each event, runs every
 * projector whose `handles` list includes the event type, then updates the
 * projector's cursor. All work happens inside a single `db.runInTransaction()`
 * so the event store and projections are consistent by construction.
 *
 * Recovery: `recover()` reads events from the minimum cursor position across
 * all projectors and replays them. This handles both cold starts (no cursors)
 * and partial failures (some projectors advanced further than others).
 */
export class ProjectionRunner {
	private readonly db: SqliteClient;
	private readonly eventStore: EventStore;
	private readonly cursorRepo: ProjectorCursorRepository;
	private readonly projectors: readonly Projector[];
	private readonly log: Logger | undefined;

	/** Pre-computed map: event type → projectors that handle it. */
	private readonly projectorsByEventType: Map<string, Projector[]>;

	/** Recent projection failures for diagnostics (capped at 100). */
	private readonly _failures: ProjectionFailure[] = [];

	/** (P3) True during `recover()` — passed to projectors via ProjectionContext. */
	private _replaying = false;

	/** (CH4) True after recover() has been called. projectEvent() throws if false. */
	private _recovered = false;

	/** (CH4) Public accessor so relay-stack.ts can assert recovery state. */
	get isRecovered(): boolean {
		return this._recovered;
	}

	/** (P2) Counter for lazy cursor sync — only write non-matching cursors every N events. */
	private eventsSinceLastCursorSync = 0;
	private readonly CURSOR_SYNC_INTERVAL = 100;

	/** (Perf-Fix-4) Batch size for async recovery. */
	private readonly recoveryBatchSize: number;

	constructor(config: ProjectionRunnerConfig) {
		this.db = config.db;
		this.eventStore = config.eventStore;
		this.cursorRepo = config.cursorRepo;
		this.projectors = config.projectors;
		this.log = config.log;
		this.recoveryBatchSize = config.recoveryBatchSize ?? 500;

		// Build the dispatch map once at construction time.
		this.projectorsByEventType = new Map();
		for (const projector of this.projectors) {
			for (const eventType of projector.handles) {
				let list = this.projectorsByEventType.get(eventType);
				if (!list) {
					list = [];
					this.projectorsByEventType.set(eventType, list);
				}
				list.push(projector);
			}
		}
	}

	/**
	 * Project a single stored event through all matching projectors.
	 *
	 * (A4) Each projector runs in its OWN transaction. If one projector
	 * fails, its transaction rolls back (including its cursor update),
	 * but other projectors proceed normally. This prevents a bug in
	 * one projector (e.g., ActivityProjector) from blocking all other
	 * projections. Recovery only needs to replay events for the failed
	 * projector since its cursor won't have advanced.
	 *
	 * Trade-off: projections can be temporarily inconsistent (session
	 * row updated but activity row not), but this is recoverable on
	 * next startup. The alternative — one broken projector blocking
	 * everything — is not recoverable without manual intervention.
	 *
	 * @param event - A fully stored event (has sequence number assigned).
	 */
	projectEvent(event: StoredEvent): void {
		// (CH4) Lifecycle check: hard error if projecting before recovery.
		if (!this._recovered) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"recover() must be called before projectEvent(). " +
					"Ensure recover() is called in relay-stack.ts before SSE wiring.",
				{ sequence: event.sequence, type: event.type },
			);
		}

		const matching = this.projectorsByEventType.get(event.type) ?? [];

		// (A4) Run each projector in its own transaction for fault isolation.
		// (P3) Pass the `replaying` flag via ProjectionContext so projectors
		// can skip expensive replay-safety checks during normal streaming.
		for (const projector of matching) {
			try {
				this.db.runInTransaction(() => {
					projector.project(event, this.db, {
						replaying: this._replaying,
					});
					this.cursorRepo.upsert(projector.name, event.sequence);
				});
			} catch (err) {
				// Record failure but continue with other projectors
				this.recordFailure(projector, event, err);
			}
		}

		// (P2) Lazy cursor advancement for non-matching projectors.
		this.eventsSinceLastCursorSync++;
		if (this.eventsSinceLastCursorSync >= this.CURSOR_SYNC_INTERVAL) {
			this.syncAllCursors(event.sequence);
			this.eventsSinceLastCursorSync = 0;
		}

		this.log?.verbose(
			`projected seq=${event.sequence} type=${event.type} projectors=${matching.map((p) => p.name).join(",") || "none"}`,
		);
	}

	/**
	 * Project multiple events in a single transaction (S9 batch optimization).
	 *
	 * When the DualWriteHook detects a translation produced multiple events
	 * (via sseBatchId), it calls projectBatch() instead of projectEvent()
	 * for each event individually.
	 *
	 * All projector calls and cursor advancement happen in one transaction.
	 * If any projector fails, the entire batch rolls back.
	 */
	projectBatch(events: readonly StoredEvent[]): void {
		if (events.length === 0) return;
		if (!this._recovered) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"recover() must be called before projectBatch(). " +
					"Ensure recover() is called in relay-stack.ts before SSE wiring.",
				{
					eventCount: events.length,
					firstSequence: events[0]?.sequence ?? 0,
				},
			);
		}

		this.db.runInTransaction(() => {
			for (const event of events) {
				const matching = this.projectorsByEventType.get(event.type) ?? [];
				for (const projector of matching) {
					projector.project(event, this.db, {
						replaying: this._replaying,
					});
				}
			}

			// Advance all cursors to the last event in the batch
			const lastEvent = events[events.length - 1];
			if (lastEvent) {
				for (const projector of this.projectors) {
					this.cursorRepo.upsert(projector.name, lastEvent.sequence);
				}
			}
		});

		const lastBatchEvent = events[events.length - 1];
		this.log?.verbose(
			`projected batch of ${events.length} events, last seq=${lastBatchEvent?.sequence}`,
		);
	}

	/**
	 * (P2) Sync all projector cursors to a given sequence in one transaction.
	 * Called periodically (every 100 events) and on PersistenceLayer.close().
	 */
	syncAllCursors(sequence: number): void {
		this.db.runInTransaction(() => {
			for (const projector of this.projectors) {
				this.cursorRepo.upsert(projector.name, sequence);
			}
		});
	}

	/** Recent failures for diagnostics. */
	getFailures(): readonly ProjectionFailure[] {
		return this._failures;
	}

	/**
	 * Recover projections by replaying events from cursor positions.
	 *
	 * (P7) Per-projector recovery with SQL-level type filtering: each
	 * projector replays from its OWN cursor using a SQL WHERE clause that
	 * filters to only the event types it handles. This prevents a fresh
	 * projector (cursor 0) from forcing ALL 100,000 events through all 6
	 * projectors, and avoids deserializing events that a projector would
	 * skip anyway.
	 *
	 * (P3) Sets `_replaying = true` so projectors enable replay-safety
	 * checks (e.g., `alreadyApplied()`) that are wasteful during normal
	 * streaming.
	 *
	 * (A3) Returns a structured `RecoveryResult` with progress reporting.
	 */
	recover(): RecoveryResult {
		const startTime = Date.now();

		// (P7) Fast path: check if all cursors are caught up
		const latestSeq =
			this.db.queryOne<{ max_seq: number | null }>(
				"SELECT MAX(sequence) AS max_seq FROM events",
			)?.max_seq ?? 0;

		const allCursors = this.cursorRepo.listAll();
		const allCaughtUp =
			allCursors.length === this.projectors.length &&
			allCursors.every((c) => c.lastAppliedSeq >= latestSeq);

		if (allCaughtUp) {
			this.log?.info("recovery: all projectors caught up, skipping replay");
			this._recovered = true;
			return {
				startCursor: latestSeq,
				endCursor: latestSeq,
				totalReplayed: 0,
				batchCount: 0,
				durationMs: 0,
				projectorCursors: allCursors,
			};
		}

		// (P3) Set replaying flag so projectors enable replay-safety checks
		this._replaying = true;
		try {
			// (P7) Per-projector recovery with SQL type filtering.
			let totalReplayed = 0;
			let batchCount = 0;
			const perProjector: ProjectorRecoveryResult[] = [];

			for (const projector of this.projectors) {
				const cursor = this.cursorRepo.get(projector.name)?.lastAppliedSeq ?? 0;
				if (cursor >= latestSeq) continue; // This projector is caught up

				const result = this.recoverProjector(
					projector,
					cursor,
					this.recoveryBatchSize,
				);
				perProjector.push(result);
				totalReplayed += result.eventsReplayed;
				batchCount += result.batchCount;
			}

			// (P2) Flush any pending cursor syncs after recovery
			this.syncAllCursors(latestSeq);
			this.eventsSinceLastCursorSync = 0;

			const result: RecoveryResult = {
				startCursor: Math.min(
					...perProjector.map((r) => r.startCursor),
					latestSeq,
				),
				endCursor: latestSeq,
				totalReplayed,
				batchCount,
				durationMs: Date.now() - startTime,
				projectorCursors: this.cursorRepo.listAll(),
			};
			this.log?.info(
				"recovery complete",
				result as unknown as Record<string, unknown>,
			);
			return result;
		} finally {
			this._replaying = false;
			// (CH4) Set recovered flag AFTER replay completes. This must be in
			// the finally block so the flag is set even if recovery throws
			// (allowing subsequent projectEvent calls from live SSE events).
			this._recovered = true;
		}
	}

	/**
	 * (Perf-Fix-4) Async recovery that yields the event loop between batches
	 * via setImmediate, allowing WebSocket/HTTP handlers to run during recovery.
	 */
	async recoverAsync(
		opts?: AsyncRecoveryOptions,
	): Promise<AsyncRecoveryResult> {
		const startTime = Date.now();
		const latestSeq =
			this.db.queryOne<{ max_seq: number | null }>(
				"SELECT MAX(sequence) AS max_seq FROM events",
			)?.max_seq ?? 0;

		const allCursors = this.cursorRepo.listAll();
		const allCaughtUp =
			allCursors.length === this.projectors.length &&
			allCursors.every((c) => c.lastAppliedSeq >= latestSeq);

		if (allCaughtUp) {
			this._recovered = true;
			this.log?.info("recovery: all projectors caught up, skipping replay");
			return { totalReplayed: 0, durationMs: 0, perProjector: [] };
		}

		const perProjector: ProjectorRecoveryResult[] = [];
		let totalReplayed = 0;

		for (const projector of this.projectors) {
			const cursor = this.cursorRepo.get(projector.name)?.lastAppliedSeq ?? 0;
			if (cursor >= latestSeq) continue;

			const result = await this.recoverProjectorAsync(
				projector,
				cursor,
				latestSeq,
				opts?.onProgress,
			);
			perProjector.push(result);
			totalReplayed += result.eventsReplayed;
		}

		this._recovered = true;
		return {
			totalReplayed,
			durationMs: Date.now() - startTime,
			perProjector,
		};
	}

	/**
	 * (Change 5b) Run recovery for specific lagging projectors only.
	 * Called by LifecycleCoordinator.onReconnect() when projection gaps
	 * are detected. Fast because it only replays the gap.
	 */
	recoverLagging(projectorNames: string[]): RecoveryResult {
		const startTime = Date.now();

		const latestSeq =
			this.db.queryOne<{ max_seq: number | null }>(
				"SELECT MAX(sequence) AS max_seq FROM events",
			)?.max_seq ?? 0;

		if (latestSeq === 0) {
			return {
				startCursor: 0,
				endCursor: 0,
				totalReplayed: 0,
				batchCount: 0,
				durationMs: 0,
				projectorCursors: this.cursorRepo.listAll(),
			};
		}

		this._replaying = true;
		try {
			let totalReplayed = 0;
			let batchCount = 0;
			const perProjector: ProjectorRecoveryResult[] = [];

			for (const projector of this.projectors) {
				if (!projectorNames.includes(projector.name)) continue;

				const cursor = this.cursorRepo.get(projector.name)?.lastAppliedSeq ?? 0;
				if (cursor >= latestSeq) continue;

				const result = this.recoverProjector(
					projector,
					cursor,
					this.recoveryBatchSize,
				);
				perProjector.push(result);
				totalReplayed += result.eventsReplayed;
				batchCount += result.batchCount;
			}

			return {
				startCursor: Math.min(
					...perProjector.map((r) => r.startCursor),
					latestSeq,
				),
				endCursor: latestSeq,
				totalReplayed,
				batchCount,
				durationMs: Date.now() - startTime,
				projectorCursors: this.cursorRepo.listAll(),
			};
		} finally {
			this._replaying = false;
		}
	}

	/** Mark as recovered without replaying (for testing). */
	markRecovered(): void {
		this._recovered = true;
	}

	// ─── Private helpers ─────────────────────────────────────────────────

	/**
	 * (P7) Recover a single projector from its cursor, fetching only events
	 * matching its `handles` list via SQL WHERE type IN (...).
	 */
	private recoverProjector(
		projector: Projector,
		fromCursor: number,
		batchSize: number,
	): ProjectorRecoveryResult {
		const startTime = Date.now();
		let replayed = 0;
		let batches = 0;
		let cursor = fromCursor;

		// Build SQL type filter from projector's handles list
		const handledTypes = projector.handles;
		const placeholders = handledTypes.map(() => "?").join(", ");

		while (true) {
			// Only fetch events this projector actually handles
			const events = this.db.query<EventRow>(
				`SELECT sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at
				 FROM events
				 WHERE sequence > ? AND type IN (${placeholders})
				 ORDER BY sequence ASC
				 LIMIT ?`,
				[cursor, ...handledTypes, batchSize],
			);
			if (events.length === 0) break;

			for (const event of events) {
				try {
					this.db.runInTransaction(() => {
						projector.project(this.rowToStoredEvent(event), this.db, {
							replaying: true,
						});
						this.cursorRepo.upsert(projector.name, event.sequence);
					});
					replayed++;
				} catch (err) {
					this.recordFailure(projector, this.rowToStoredEvent(event), err);
				}
			}

			const lastInBatch = events[events.length - 1];
			if (lastInBatch) cursor = lastInBatch.sequence;
			batches++;
			this.log?.info(
				`recovery: ${projector.name} batch=${batches} replayed=${replayed} cursor=${cursor}`,
			);
		}

		// Advance cursor to the global max (skip all non-matching events)
		const maxSeq = this.db.queryOne<{ max_seq: number | null }>(
			"SELECT MAX(sequence) AS max_seq FROM events",
		)?.max_seq;
		if (maxSeq != null && maxSeq > cursor) {
			this.cursorRepo.upsert(projector.name, maxSeq);
		}

		return {
			projectorName: projector.name,
			startCursor: fromCursor,
			endCursor: maxSeq ?? cursor,
			eventsReplayed: replayed,
			batchCount: batches,
			durationMs: Date.now() - startTime,
		};
	}

	private async recoverProjectorAsync(
		projector: Projector,
		fromCursor: number,
		totalEstimated: number,
		onProgress?: (progress: RecoveryProgress) => void,
	): Promise<ProjectorRecoveryResult> {
		const startTime = Date.now();
		let replayed = 0;
		let cursor = fromCursor;

		const handledTypes = projector.handles;
		const placeholders = handledTypes.map(() => "?").join(", ");

		while (true) {
			const events = this.db.query<EventRow>(
				`SELECT sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at
				 FROM events
				 WHERE sequence > ? AND type IN (${placeholders})
				 ORDER BY sequence ASC
				 LIMIT ?`,
				[cursor, ...handledTypes, this.recoveryBatchSize],
			);
			if (events.length === 0) break;

			for (const event of events) {
				try {
					this.db.runInTransaction(() => {
						projector.project(this.rowToStoredEvent(event), this.db, {
							replaying: true,
						});
						this.cursorRepo.upsert(projector.name, event.sequence);
					});
					replayed++;
				} catch (err) {
					this.recordFailure(projector, this.rowToStoredEvent(event), err);
				}
			}

			const lastInBatch = events[events.length - 1];
			if (lastInBatch) cursor = lastInBatch.sequence;

			onProgress?.({
				projectorName: projector.name,
				eventsReplayed: replayed,
				totalEstimated,
				durationMs: Date.now() - startTime,
			});

			if (events.length >= this.recoveryBatchSize) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}

		const maxSeq = this.db.queryOne<{ max_seq: number | null }>(
			"SELECT MAX(sequence) AS max_seq FROM events",
		)?.max_seq;
		if (maxSeq != null && maxSeq > cursor) {
			this.cursorRepo.upsert(projector.name, maxSeq);
		}

		return {
			projectorName: projector.name,
			startCursor: fromCursor,
			endCursor: maxSeq ?? cursor,
			eventsReplayed: replayed,
			batchCount: 0, // not tracked in async path
			durationMs: Date.now() - startTime,
		};
	}

	private recordFailure(
		projector: Projector,
		event: StoredEvent,
		err: unknown,
	): void {
		const failure: ProjectionFailure = {
			projectorName: projector.name,
			eventSequence: event.sequence,
			eventType: event.type,
			sessionId: event.sessionId,
			error: err instanceof Error ? err.message : String(err),
			errorCode: err instanceof PersistenceError ? err.code : undefined,
			failedAt: Date.now(),
		};
		this._failures.push(failure);
		// Cap at 100 entries to avoid unbounded growth
		if (this._failures.length > 100) this._failures.shift();

		this.log?.warn(
			`Projector "${projector.name}" failed on event seq=${event.sequence}`,
			{
				projector: projector.name,
				sequence: event.sequence,
				type: event.type,
				sessionId: event.sessionId,
				error:
					err instanceof PersistenceError
						? err.toLog()
						: formatErrorDetail(err),
			},
		);
	}

	private rowToStoredEvent(row: EventRow): StoredEvent {
		if (!CANONICAL_EVENT_TYPES.includes(row.type as CanonicalEventType)) {
			throw new PersistenceError(
				"UNKNOWN_EVENT_TYPE",
				`Unknown event type in database: ${row.type}`,
				{
					sequence: row.sequence,
					eventId: row.event_id,
					sessionId: row.session_id,
					type: row.type,
				},
			);
		}

		let data: unknown;
		let metadata: unknown;
		try {
			data = JSON.parse(row.data);
		} catch (err) {
			throw new PersistenceError(
				"DESERIALIZATION_FAILED",
				"Failed to parse event data JSON",
				{
					sequence: row.sequence,
					eventId: row.event_id,
					sessionId: row.session_id,
					type: row.type,
					rawData: row.data.slice(0, 200),
					parseError: err instanceof Error ? err.message : String(err),
				},
			);
		}
		try {
			metadata = JSON.parse(row.metadata);
		} catch (err) {
			throw new PersistenceError(
				"DESERIALIZATION_FAILED",
				"Failed to parse event metadata JSON",
				{
					sequence: row.sequence,
					eventId: row.event_id,
					rawMetadata: row.metadata.slice(0, 200),
					parseError: err instanceof Error ? err.message : String(err),
				},
			);
		}

		return {
			sequence: row.sequence,
			eventId: row.event_id,
			sessionId: row.session_id,
			streamVersion: row.stream_version,
			type: row.type,
			data,
			metadata,
			provider: row.provider,
			createdAt: row.created_at,
		} as StoredEvent;
	}
}
