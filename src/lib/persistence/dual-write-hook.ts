// ─── Dual-Write Hook (Task 10) ──────────────────────────────────────────────
// Central coordination point: receives SSE events, translates them to
// canonical events, ensures the session exists, and appends to the event store.
// Never throws — all errors are caught, logged, and returned as results.

import { formatErrorDetail } from "../errors.js";
import type { OpenCodeEvent } from "../types.js";
import { CanonicalEventTranslator } from "./canonical-event-translator.js";
import { canonicalEvent, createEventId } from "./events.js";
import type { PersistenceLayer } from "./persistence-layer.js";
import { SessionSeeder } from "./session-seeder.js";

// ─── Logger Interface ───────────────────────────────────────────────────────

export interface DualWriteLog {
	warn(msg: string, context?: Record<string, unknown>): void;
	debug(msg: string, context?: Record<string, unknown>): void;
	info(msg: string, context?: Record<string, unknown>): void;
	verbose(msg: string, context?: Record<string, unknown>): void;
}

// ─── Result Types ───────────────────────────────────────────────────────────

export type DualWriteResult =
	| { ok: true; eventsWritten: number; sessionSeeded: boolean }
	| {
			ok: false;
			reason: "disabled" | "no-session" | "not-translatable" | "error";
			error?: string;
	  };

// ─── Statistics ─────────────────────────────────────────────────────────────

export interface DualWriteStats {
	eventsReceived: number;
	eventsWritten: number;
	eventsSkipped: number;
	errors: number;
}

// ─── Hook Options ───────────────────────────────────────────────────────────

export interface DualWriteHookOptions {
	persistence: PersistenceLayer;
	log: DualWriteLog;
	/** Set to false to disable the hook without removing it. Defaults to true. */
	enabled?: boolean;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export class DualWriteHook {
	private readonly persistence: PersistenceLayer;
	private readonly log: DualWriteLog;
	private readonly translator: CanonicalEventTranslator;
	private readonly seeder: SessionSeeder;

	/** Set to false to disable the hook without removing it. */
	enabled = true;

	// Stats
	private stats: DualWriteStats = {
		eventsReceived: 0,
		eventsWritten: 0,
		eventsSkipped: 0,
		errors: 0,
	};

	private statsIntervalId: ReturnType<typeof setInterval> | undefined;

	constructor(opts: DualWriteHookOptions) {
		this.persistence = opts.persistence;
		this.log = opts.log;
		if (opts.enabled !== undefined) {
			this.enabled = opts.enabled;
		}
		this.translator = new CanonicalEventTranslator();
		this.seeder = new SessionSeeder(opts.persistence.db);
	}

	// ─── Main Entry Point ─────────────────────────────────────────────────

	/**
	 * Process an incoming SSE event:
	 * 1. Translate to canonical events
	 * 2. Seed session if new
	 * 3. Append all canonical events to the event store
	 *
	 * Never throws.
	 */
	onSSEEvent(
		event: OpenCodeEvent,
		sessionId: string | undefined,
	): DualWriteResult {
		this.stats.eventsReceived++;

		if (!this.enabled) {
			this.stats.eventsSkipped++;
			return { ok: false, reason: "disabled" };
		}

		if (!sessionId) {
			this.stats.eventsSkipped++;
			this.log.debug("dual-write: skipping event with no sessionId", {
				eventType: event.type,
			});
			return { ok: false, reason: "no-session" };
		}

		try {
			// Translate SSE event to canonical events
			const translated = this.translator.translate(event, sessionId);

			if (!translated || translated.length === 0) {
				this.stats.eventsSkipped++;
				this.log.verbose("dual-write: event not translatable, skipping", {
					eventType: event.type,
					sessionId,
				});
				return { ok: false, reason: "not-translatable" };
			}

			// Seed session if needed, and build the batch
			const sessionSeeded = this.seeder.ensureSession(sessionId, "opencode");

			const batch = [];

			if (sessionSeeded) {
				// Emit synthetic session.created before the translated events
				const syntheticEvent = canonicalEvent(
					"session.created",
					sessionId,
					{
						sessionId,
						title: "Untitled",
						provider: "opencode",
					},
					{
						eventId: createEventId(),
						metadata: {
							synthetic: true,
							source: "session-seeder",
						},
					},
				);
				batch.push(syntheticEvent);
			}

			batch.push(...translated);

			// Append all events to the store
			const storedEvents = this.persistence.eventStore.appendBatch(batch);

			const written = batch.length;
			this.stats.eventsWritten += written;

			// Project stored events into read model tables.
			// Projection errors are logged but never break the relay pipeline.
			try {
				if (storedEvents.length === 1 && storedEvents[0]) {
					this.persistence.projectionRunner.projectEvent(storedEvents[0]);
				} else if (storedEvents.length > 1) {
					this.persistence.projectionRunner.projectBatch(storedEvents);
				}
			} catch (projErr: unknown) {
				this.log.warn("dual-write: projection failed (non-fatal)", {
					eventType: event.type,
					sessionId,
					error: formatErrorDetail(projErr),
				});
			}

			this.log.debug("dual-write: appended events", {
				sessionId,
				eventType: event.type,
				eventsWritten: written,
				sessionSeeded,
			});

			return { ok: true, eventsWritten: written, sessionSeeded };
		} catch (err: unknown) {
			this.stats.errors++;
			const detail = formatErrorDetail(err);
			this.log.warn("dual-write: failed to persist event", {
				eventType: event.type,
				sessionId,
				error: detail,
			});
			return { ok: false, reason: "error", error: detail };
		}
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────

	/**
	 * Called when the SSE connection reconnects. Resets translator state
	 * so part tracking starts fresh.
	 */
	onReconnect(): void {
		this.translator.reset();
		this.log.info("dual-write: translator reset on reconnect");
	}

	// ─── Diagnostics ─────────────────────────────────────────────────────

	/** Get a snapshot of hook statistics. */
	getStats(): Readonly<DualWriteStats> {
		return { ...this.stats };
	}

	/**
	 * Start periodic stats logging at the given interval (ms).
	 * Defaults to 60 seconds.
	 */
	startStatsLogging(intervalMs = 60_000): void {
		this.stopStatsLogging();
		this.statsIntervalId = setInterval(() => {
			const s = this.stats;
			this.log.info("dual-write stats", {
				eventsReceived: s.eventsReceived,
				eventsWritten: s.eventsWritten,
				eventsSkipped: s.eventsSkipped,
				errors: s.errors,
			});
		}, intervalMs);
		// Allow the process to exit even if the interval is active
		if (
			typeof this.statsIntervalId === "object" &&
			"unref" in this.statsIntervalId
		) {
			this.statsIntervalId.unref();
		}
	}

	/** Stop periodic stats logging. */
	stopStatsLogging(): void {
		if (this.statsIntervalId !== undefined) {
			clearInterval(this.statsIntervalId);
			this.statsIntervalId = undefined;
		}
	}
}
