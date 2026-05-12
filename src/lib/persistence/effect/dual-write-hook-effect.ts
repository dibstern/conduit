import { Effect } from "effect";
import { formatErrorDetail } from "../../errors.js";
import type { SSEEvent } from "../../relay/opencode-events.js";
import { CanonicalEventTranslator } from "../canonical-event-translator.js";
import type {
	DualWriteHookPort,
	DualWriteLog,
	DualWriteResult,
	DualWriteStats,
} from "../dual-write-hook.js";
import { canonicalEvent, createEventId } from "../events.js";
import { EventStoreEffectTag } from "./event-store-effect.js";
import type { PersistenceEffectRuntime } from "./live.js";
import { ProjectionRunnerEffectTag } from "./projection-runner-effect.js";
import { EffectSessionSeeder } from "./session-seeder-effect.js";

export interface EffectDualWriteHookOptions {
	readonly runtime: PersistenceEffectRuntime;
	readonly log: DualWriteLog;
}

export class EffectDualWriteHook implements DualWriteHookPort {
	private readonly runtime: PersistenceEffectRuntime;
	private readonly log: DualWriteLog;
	private readonly translator: CanonicalEventTranslator;
	private readonly seeder: EffectSessionSeeder;

	private stats: DualWriteStats = {
		eventsReceived: 0,
		eventsWritten: 0,
		eventsSkipped: 0,
		errors: 0,
	};

	private statsIntervalId: ReturnType<typeof setInterval> | undefined;

	constructor(opts: EffectDualWriteHookOptions) {
		this.runtime = opts.runtime;
		this.log = opts.log;
		this.translator = new CanonicalEventTranslator();
		this.seeder = new EffectSessionSeeder();
		this.runtime.runSync(
			Effect.gen(function* () {
				const projectionRunner = yield* ProjectionRunnerEffectTag;
				yield* projectionRunner.recover();
			}),
		);
	}

	onSSEEvent(event: SSEEvent, sessionId: string | undefined): DualWriteResult {
		this.stats.eventsReceived++;

		if (!sessionId) {
			this.stats.eventsSkipped++;
			this.log.debug("dual-write: skipping event with no sessionId", {
				eventType: event.type,
			});
			return { ok: false, reason: "no-session" };
		}

		try {
			const translated = this.translator.translate(event, sessionId);

			if (!translated || translated.length === 0) {
				this.stats.eventsSkipped++;
				this.log.verbose("dual-write: event not translatable, skipping", {
					eventType: event.type,
					sessionId,
				});
				return { ok: false, reason: "not-translatable" };
			}

			const seeder = this.seeder;
			const result = this.runtime.runSync(
				Effect.gen(function* () {
					const eventStore = yield* EventStoreEffectTag;
					const projectionRunner = yield* ProjectionRunnerEffectTag;
					const sessionSeeded = yield* seeder.ensureSession(
						sessionId,
						"opencode",
					);
					const batch = [];

					if (sessionSeeded) {
						batch.push(
							canonicalEvent(
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
							),
						);
					}

					batch.push(...translated);

					const storedEvents = yield* eventStore.appendBatch(batch);
					const written = batch.length;

					const projectionResult = yield* Effect.either(
						storedEvents.length === 1 && storedEvents[0]
							? projectionRunner.projectEvent(storedEvents[0])
							: projectionRunner.projectBatch(storedEvents),
					);

					return { projectionResult, sessionSeeded, written };
				}),
			);

			this.stats.eventsWritten += result.written;

			if (result.projectionResult._tag === "Left") {
				this.log.warn("dual-write: projection failed (non-fatal)", {
					eventType: event.type,
					sessionId,
					error: formatErrorDetail(result.projectionResult.left),
				});
			}

			this.log.debug("dual-write: appended events", {
				sessionId,
				eventType: event.type,
				eventsWritten: result.written,
				sessionSeeded: result.sessionSeeded,
			});

			return {
				ok: true,
				eventsWritten: result.written,
				sessionSeeded: result.sessionSeeded,
			};
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

	onReconnect(): void {
		this.translator.reset();
		this.seeder.reset();
		this.log.info("dual-write: translator reset on reconnect");
	}

	getStats(): Readonly<DualWriteStats> {
		return { ...this.stats };
	}

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
		if (
			typeof this.statsIntervalId === "object" &&
			"unref" in this.statsIntervalId
		) {
			this.statsIntervalId.unref();
		}
	}

	stopStatsLogging(): void {
		if (this.statsIntervalId !== undefined) {
			clearInterval(this.statsIntervalId);
			this.statsIntervalId = undefined;
		}
	}
}
