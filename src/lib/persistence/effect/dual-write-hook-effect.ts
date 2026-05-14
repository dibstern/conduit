import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";
import { formatErrorDetail } from "../../errors.js";
import type { SSEEvent } from "../../relay/opencode-events.js";
import { CanonicalEventTranslator } from "../canonical-event-translator.js";
import type {
	DualWriteLog,
	DualWriteResult,
	DualWriteStats,
} from "../dual-write-hook.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	createEventId,
} from "../events.js";
import {
	type EventStoreEffect,
	EventStoreEffectTag,
} from "./event-store-effect.js";
import {
	type ProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
	type ProjectionRunnerError,
} from "./projection-runner-effect.js";
import { EffectSessionSeeder } from "./session-seeder-effect.js";

export interface EffectDualWriteHookOptions {
	readonly sql: SqlClient.SqlClient;
	readonly eventStore: EventStoreEffect;
	readonly projectionRunner: ProjectionRunnerEffect;
	readonly log: DualWriteLog;
}

export interface EffectDualWriteHookPort {
	onSSEEventEffect(
		event: SSEEvent,
		sessionId: string | undefined,
	): Effect.Effect<DualWriteResult>;
	onReconnect(): void;
	getStats(): Readonly<DualWriteStats>;
	startStatsLogging(intervalMs?: number): void;
	stopStatsLogging(): void;
}

export class EffectDualWriteHook implements EffectDualWriteHookPort {
	private readonly sql: SqlClient.SqlClient;
	private readonly eventStore: EventStoreEffect;
	private readonly projectionRunner: ProjectionRunnerEffect;
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
		this.sql = opts.sql;
		this.eventStore = opts.eventStore;
		this.projectionRunner = opts.projectionRunner;
		this.log = opts.log;
		this.translator = new CanonicalEventTranslator();
		this.seeder = new EffectSessionSeeder();
	}

	private withSql<A, E>(
		effect: Effect.Effect<A, E, SqlClient.SqlClient>,
	): Effect.Effect<A, E> {
		return effect.pipe(Effect.provideService(SqlClient.SqlClient, this.sql));
	}

	recoverEffect(): Effect.Effect<void, ProjectionRunnerError | SqlError> {
		return this.withSql(this.projectionRunner.recover()).pipe(Effect.asVoid);
	}

	onSSEEventEffect(
		event: SSEEvent,
		sessionId: string | undefined,
	): Effect.Effect<DualWriteResult> {
		return Effect.gen(this, function* () {
			this.stats.eventsReceived++;

			if (!sessionId) {
				this.stats.eventsSkipped++;
				this.log.debug("dual-write: skipping event with no sessionId", {
					eventType: event.type,
				});
				return { ok: false, reason: "no-session" } satisfies DualWriteResult;
			}

			const translated = yield* Effect.try({
				try: () => this.translator.translate(event, sessionId),
				catch: (cause) => cause,
			});

			if (!translated || translated.length === 0) {
				this.stats.eventsSkipped++;
				this.log.verbose("dual-write: event not translatable, skipping", {
					eventType: event.type,
					sessionId,
				});
				return {
					ok: false,
					reason: "not-translatable",
				} satisfies DualWriteResult;
			}

			const seeder = this.seeder;
			const sessionSeeded = yield* this.withSql(
				seeder.ensureSession(sessionId, "opencode"),
			);
			const batch: CanonicalEvent[] = [];

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

			const storedEvents = yield* this.eventStore.appendBatch(batch);
			const written = batch.length;

			const projectionResult = yield* Effect.either(
				storedEvents.length === 1 && storedEvents[0]
					? this.withSql(this.projectionRunner.projectEvent(storedEvents[0]))
					: this.withSql(this.projectionRunner.projectBatch(storedEvents)),
			);

			this.stats.eventsWritten += written;

			if (projectionResult._tag === "Left") {
				this.log.warn("dual-write: projection failed (non-fatal)", {
					eventType: event.type,
					sessionId,
					error: formatErrorDetail(projectionResult.left),
				});
			}

			this.log.debug("dual-write: appended events", {
				sessionId,
				eventType: event.type,
				eventsWritten: written,
				sessionSeeded,
			});

			return {
				ok: true,
				eventsWritten: written,
				sessionSeeded,
			} satisfies DualWriteResult;
		}).pipe(
			Effect.catchAll((err: unknown) =>
				Effect.sync(() => {
					this.stats.errors++;
					const detail = formatErrorDetail(err);
					this.log.warn("dual-write: failed to persist event", {
						eventType: event.type,
						sessionId,
						error: detail,
					});
					return { ok: false, reason: "error", error: detail } as const;
				}),
			),
		);
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

export const makeEffectDualWriteHook = (
	log: DualWriteLog,
): Effect.Effect<
	EffectDualWriteHook,
	ProjectionRunnerError | SqlError,
	SqlClient.SqlClient | EventStoreEffectTag | ProjectionRunnerEffectTag
> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const eventStore = yield* EventStoreEffectTag;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const hook = new EffectDualWriteHook({
			sql,
			eventStore,
			projectionRunner,
			log,
		});
		yield* hook.recoverEffect();
		return hook;
	});
