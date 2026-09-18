import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import { formatErrorDetail } from "../../../errors.js";
import {
	type ProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
	type ProjectionRunnerError,
} from "../../../persistence/effect/projection-runner-effect.js";
import {
	OpenCodeRuntimeEventTranslator,
	opencodeSessionCreatedRuntimeEvent,
} from "../../../provider/opencode/opencode-runtime-event-translator.js";
import type { SSEEvent } from "../../../relay/opencode-events.js";
import {
	type ProviderRuntimeIngestion,
	ProviderRuntimeIngestionTag,
} from "./provider-runtime-ingestion-service.js";

export interface OpenCodeRuntimeIngressLog {
	warn(msg: string, context?: Record<string, unknown>): void;
	debug(msg: string, context?: Record<string, unknown>): void;
	info(msg: string, context?: Record<string, unknown>): void;
	verbose(msg: string, context?: Record<string, unknown>): void;
}

export type OpenCodeRuntimeIngressResult =
	| { ok: true; eventsWritten: number; sessionSeeded: boolean }
	| {
			ok: false;
			reason: "no-session" | "not-translatable" | "error";
			error?: string;
	  };

export interface OpenCodeRuntimeIngressStats {
	eventsReceived: number;
	eventsWritten: number;
	eventsSkipped: number;
	errors: number;
}

export interface EffectOpenCodeRuntimeIngressPort {
	onSSEEventEffect(
		event: SSEEvent,
		sessionId: string | undefined,
		providerInstanceId: string,
	): Effect.Effect<OpenCodeRuntimeIngressResult>;
	onReconnect(): void;
	getStats(): Readonly<OpenCodeRuntimeIngressStats>;
	startStatsLogging(intervalMs?: number): void;
	stopStatsLogging(): void;
}

export interface EffectOpenCodeRuntimeIngressOptions {
	readonly sql: SqlClient.SqlClient;
	readonly projectionRunner: ProjectionRunnerEffect;
	readonly ingestion: ProviderRuntimeIngestion;
	readonly log: OpenCodeRuntimeIngressLog;
}

export class EffectOpenCodeRuntimeIngress
	implements EffectOpenCodeRuntimeIngressPort
{
	private readonly sql: SqlClient.SqlClient;
	private readonly projectionRunner: ProjectionRunnerEffect;
	private readonly ingestion: ProviderRuntimeIngestion;
	private readonly log: OpenCodeRuntimeIngressLog;
	private readonly translator = new OpenCodeRuntimeEventTranslator();
	private readonly seenSessions = new Set<string>();
	/** One permit per session. Provider callbacks for a session overlap, and
	 *  translation state may only advance once the events it produced have
	 *  committed, so translate → persist → keep runs as one critical section. */
	private readonly sessionGates = new Map<string, Effect.Semaphore>();

	private stats: OpenCodeRuntimeIngressStats = {
		eventsReceived: 0,
		eventsWritten: 0,
		eventsSkipped: 0,
		errors: 0,
	};

	private statsIntervalId: ReturnType<typeof setInterval> | undefined;

	constructor(opts: EffectOpenCodeRuntimeIngressOptions) {
		this.sql = opts.sql;
		this.projectionRunner = opts.projectionRunner;
		this.ingestion = opts.ingestion;
		this.log = opts.log;
	}

	private withSql<A, E>(
		effect: Effect.Effect<A, E, SqlClient.SqlClient>,
	): Effect.Effect<A, E> {
		return effect.pipe(Effect.provideService(SqlClient.SqlClient, this.sql));
	}

	private sessionGate(sessionId: string): Effect.Semaphore {
		const existing = this.sessionGates.get(sessionId);
		if (existing) return existing;
		const gate = Effect.unsafeMakeSemaphore(1);
		this.sessionGates.set(sessionId, gate);
		return gate;
	}

	private hasProjectedSession(sessionId: string): Effect.Effect<boolean> {
		return this.withSql(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<{ id: string }>`
					SELECT id FROM sessions
					WHERE id = ${sessionId}
					LIMIT 1`;
				return rows.length > 0;
			}),
		).pipe(Effect.catchAllCause(() => Effect.succeed(false)));
	}

	recoverEffect(): Effect.Effect<void, ProjectionRunnerError | SqlError> {
		return this.withSql(this.projectionRunner.recover()).pipe(Effect.asVoid);
	}

	onSSEEventEffect(
		event: SSEEvent,
		sessionId: string | undefined,
		providerInstanceId: string,
	): Effect.Effect<OpenCodeRuntimeIngressResult> {
		return Effect.gen(this, function* () {
			this.stats.eventsReceived++;

			if (!sessionId) {
				this.stats.eventsSkipped++;
				this.log.debug(
					"opencode-runtime-ingress: skipping event with no sessionId",
					{
						eventType: event.type,
					},
				);
				return {
					ok: false,
					reason: "no-session",
				} satisfies OpenCodeRuntimeIngressResult;
			}

			return yield* this.sessionGate(sessionId).withPermits(1)(
				this.ingestSessionEvent(event, sessionId, providerInstanceId),
			);
		}).pipe(
			Effect.catchAll((err: unknown) =>
				Effect.sync(() => {
					this.stats.errors++;
					const detail = formatErrorDetail(err);
					this.log.warn("opencode-runtime-ingress: failed to ingest event", {
						eventType: event.type,
						sessionId,
						error: detail,
					});
					return { ok: false, reason: "error", error: detail } as const;
				}),
			),
		);
	}

	private ingestSessionEvent(
		event: SSEEvent,
		sessionId: string,
		providerInstanceId: string,
	): Effect.Effect<OpenCodeRuntimeIngressResult, unknown> {
		return Effect.gen(this, function* () {
			const translation = this.translator.forkSession(sessionId);
			const translated = yield* Effect.try({
				try: () => this.translator.translateInto(event, sessionId, translation),
				catch: (cause) => cause,
			});

			if (!translated || translated.length === 0) {
				// Nothing to persist, so nothing can roll back: whatever the
				// translator learned about this event stands.
				this.translator.commitSession(sessionId, translation);
				this.stats.eventsSkipped++;
				this.log.verbose(
					"opencode-runtime-ingress: event not translatable, skipping",
					{
						eventType: event.type,
						sessionId,
					},
				);
				return {
					ok: false,
					reason: "not-translatable",
				} satisfies OpenCodeRuntimeIngressResult;
			}

			const sessionSeeded = !this.seenSessions.has(sessionId);
			const shouldAppendSessionCreation =
				sessionSeeded && !(yield* this.hasProjectedSession(sessionId));
			const runtimeEvents: ProviderRuntimeEvent[] = shouldAppendSessionCreation
				? [
						opencodeSessionCreatedRuntimeEvent(sessionId, providerInstanceId),
						...translated,
					]
				: [...translated];
			// Persist and signal committed events to SessionEventBus, but never
			// publish to the relay. The legacy SSE translator (sse-wiring.ts) is
			// the sole live-delivery path to the browser for OpenCode; publishing
			// here too would deliver every streamed delta twice (rendered as
			// doubled text, e.g. "I'mI'm ready. ready.").
			//
			// Translation state advances with the events it produced and not
			// before: a batch that rolled back leaves the fork unused, so the next
			// copy of the same event translates and persists again. It advances at
			// the durable boundary — inside the append+project transaction's
			// uninterruptible region, after COMMIT and before publication — because
			// everything after COMMIT (bus publish, relay publish) can die or be
			// interrupted while the batch stays durable, and a retry then would
			// translate the same event onto a store that already holds it.
			const written = yield* this.ingestion.ingestBatch(runtimeEvents, {
				publishToRelay: false,
				afterCommit: Effect.sync(() => {
					this.translator.commitSession(sessionId, translation);
					this.seenSessions.add(sessionId);
				}),
			});

			this.stats.eventsWritten += written;
			this.log.debug("opencode-runtime-ingress: appended events", {
				sessionId,
				eventType: event.type,
				eventsWritten: written,
				sessionSeeded,
			});

			return {
				ok: true,
				eventsWritten: written,
				sessionSeeded,
			} satisfies OpenCodeRuntimeIngressResult;
		});
	}

	/** Synchronous by contract (the SSE callback calls it inline) and safe to
	 *  stay that way: it bumps a reconnect generation and drops announcements in
	 *  one synchronous step, with no suspension point for an in-flight ingest to
	 *  interleave with, and a fork translated under the old generation drops its
	 *  announcements when it commits. Taking every session gate instead would
	 *  have to block a callback on in-flight SQL and would still miss sessions
	 *  whose gate is created after the sweep. */
	onReconnect(): void {
		this.translator.resetAnnouncements();
		this.log.info("opencode-runtime-ingress: translator reset on reconnect");
	}

	getStats(): Readonly<OpenCodeRuntimeIngressStats> {
		return { ...this.stats };
	}

	startStatsLogging(intervalMs = 60_000): void {
		this.stopStatsLogging();
		this.statsIntervalId = setInterval(() => {
			const s = this.stats;
			this.log.info("opencode-runtime-ingress stats", {
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

export const makeEffectOpenCodeRuntimeIngress = (
	log: OpenCodeRuntimeIngressLog,
): Effect.Effect<
	EffectOpenCodeRuntimeIngress,
	ProjectionRunnerError | SqlError,
	SqlClient.SqlClient | ProjectionRunnerEffectTag | ProviderRuntimeIngestionTag
> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const ingress = new EffectOpenCodeRuntimeIngress({
			sql,
			projectionRunner,
			ingestion,
			log,
		});
		yield* ingress.recoverEffect();
		return ingress;
	});
