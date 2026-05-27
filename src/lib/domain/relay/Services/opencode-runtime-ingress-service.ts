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

	private hasDurableSession(sessionId: string): Effect.Effect<boolean> {
		return this.withSql(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<{ id: string }>`
					SELECT id FROM sessions WHERE id = ${sessionId} LIMIT 1`;
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

			const translated = yield* Effect.try({
				try: () => this.translator.translate(event, sessionId),
				catch: (cause) => cause,
			});

			if (!translated || translated.length === 0) {
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
			const runtimeEvents: ProviderRuntimeEvent[] = sessionSeeded
				? [opencodeSessionCreatedRuntimeEvent(sessionId), ...translated]
				: [...translated];
			const written = yield* this.ingestion.ingestBatch(runtimeEvents);
			if (sessionSeeded) this.seenSessions.add(sessionId);

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
		}).pipe(
			Effect.catchAll((err: unknown) =>
				Effect.gen(this, function* () {
					this.stats.errors++;
					const detail = formatErrorDetail(err);
					const durableSession =
						sessionId != null
							? yield* this.hasDurableSession(sessionId)
							: false;
					if (durableSession && sessionId != null) {
						this.seenSessions.add(sessionId);
					}
					this.log.warn("opencode-runtime-ingress: failed to ingest event", {
						eventType: event.type,
						sessionId,
						error: detail,
						durableSession,
					});
					return { ok: false, reason: "error", error: detail } as const;
				}),
			),
		);
	}

	onReconnect(): void {
		this.translator.reset();
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
