import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Cause, Context, Effect, type Fiber, FiberId } from "effect";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import { formatErrorDetail } from "../../../errors.js";
import type { Message } from "../../../instance/sdk-types.js";
import {
	type ProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
	type ProjectionRunnerError,
} from "../../../persistence/effect/projection-runner-effect.js";
import {
	isSettled,
	snapshotPayload,
	synthesizeSnapshotEvent,
} from "../../../provider/opencode/opencode-history-backfill.js";
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
	onReconnect(providerInstanceId?: string): Effect.Effect<void, SqlError>;
	reconcileSession(sessionId: string): Effect.Effect<void>;
	shutdown(): void;
	isHistoryComplete(sessionId: string): Effect.Effect<boolean>;
	getStats(): Readonly<OpenCodeRuntimeIngressStats>;
	startStatsLogging(intervalMs?: number): void;
	stopStatsLogging(): void;
}

export class OpenCodeHistoryReconcileTag extends Context.Tag(
	"OpenCodeHistoryReconcile",
)<
	OpenCodeHistoryReconcileTag,
	{ reconcileSession(sessionId: string): Effect.Effect<void> }
>() {}

export class OpenCodeSessionCreationGateTag extends Context.Tag(
	"OpenCodeSessionCreationGate",
)<OpenCodeSessionCreationGateTag, Effect.Semaphore>() {}

export interface EffectOpenCodeRuntimeIngressOptions {
	readonly sql: SqlClient.SqlClient;
	readonly projectionRunner: ProjectionRunnerEffect;
	readonly ingestion: ProviderRuntimeIngestion;
	readonly log: OpenCodeRuntimeIngressLog;
	readonly sessionCreationGate?: Effect.Semaphore;
	/** The provider's REST record of a session, for the first-sighting history
	 *  backfill. Without it a session projects only what Conduit observes. */
	readonly fetchSessionMessages?: (
		sessionId: string,
		providerInstanceId: string,
		signal: AbortSignal,
	) => Effect.Effect<readonly Message[], unknown>;
	/** The send a user message echo belongs to, from the OpenCode adapter. */
	readonly inputIdForUserEcho?: (
		sessionId: string,
		messageId: string,
	) => string | undefined;
}

const BACKFILL_TIMEOUT = "15 seconds";
const BACKFILL_RETRY_MAX_MS = 30_000;
const BACKFILL_CONCURRENCY = 4;
const BACKFILL_PENDING_MAX_ATTEMPTS = 3;

type StoredMessage = {
	id: string;
	rest_digest: string | null;
	rest_event_id: string | null;
};

function isSettlingEvent(event: SSEEvent): boolean {
	const status =
		"status" in event.properties ? event.properties.status : undefined;
	const info = "info" in event.properties ? event.properties.info : undefined;
	return (
		(event.type === "session.status" &&
			typeof status === "object" &&
			status !== null &&
			"type" in status &&
			status.type === "idle") ||
		(event.type === "message.updated" &&
			typeof info === "object" &&
			info !== null &&
			"time" in info &&
			typeof info.time === "object" &&
			info.time !== null &&
			"completed" in info.time &&
			info.time.completed != null)
	);
}

export class EffectOpenCodeRuntimeIngress
	implements EffectOpenCodeRuntimeIngressPort
{
	private readonly sql: SqlClient.SqlClient;
	private readonly projectionRunner: ProjectionRunnerEffect;
	private readonly ingestion: ProviderRuntimeIngestion;
	private readonly log: OpenCodeRuntimeIngressLog;
	private stopped = false;
	private readonly fetchSessionMessages:
		| EffectOpenCodeRuntimeIngressOptions["fetchSessionMessages"]
		| undefined;
	private readonly translator: OpenCodeRuntimeEventTranslator;
	private readonly seenSessions = new Set<string>();
	/** Parents named by `session.created`, which translates to nothing, kept
	 *  until the session's first translatable event seeds it. A sub-agent seeded
	 *  without one would be a root, and roots get the turn-end dot. */
	private readonly parentIds = new Map<string, string>();
	/** One permit per session. Provider callbacks for a session overlap, and
	 *  translation state may only advance once the events it produced have
	 *  committed, so translate → persist → keep runs as one critical section. */
	private readonly sessionGates = new Map<string, Effect.Semaphore>();
	private readonly sessionCreationGate: Effect.Semaphore;
	private readonly backfillFetchPermits =
		Effect.unsafeMakeSemaphore(BACKFILL_CONCURRENCY);
	/** Sessions whose history was reconciled with the provider's REST record
	 *  since the stream last (re)connected. Unlike seenSessions it is cleared
	 *  on reconnect, so the next event of each session backfills the gap. */
	private readonly syncedSessions = new Set<string>();
	private readonly sessionInstanceIds = new Map<string, string>();
	private readonly reconnectGenerations = new Map<string, number>();
	private readonly backfillRetries = new Map<
		string,
		{ failures: number; after: number }
	>();
	private readonly pendingAttempts = new Map<string, number>();
	private readonly terminalRechecks = new Set<string>();
	private readonly terminalRecheckQueued = new Set<string>();
	private readonly backfillsInFlight = new Set<string>();
	private readonly historyRevisions = new Map<string, number>();
	private readonly backfillControllers = new Map<string, AbortController>();
	private readonly backfillFibers = new Map<
		string,
		Fiber.RuntimeFiber<void, never>
	>();

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
		this.sessionCreationGate =
			opts.sessionCreationGate ?? Effect.unsafeMakeSemaphore(1);
		this.fetchSessionMessages = opts.fetchSessionMessages;
		this.translator = new OpenCodeRuntimeEventTranslator(
			undefined,
			opts.inputIdForUserEcho,
		);
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

	private deferBackfill(sessionId: string): void {
		const failures = (this.backfillRetries.get(sessionId)?.failures ?? 0) + 1;
		this.backfillRetries.set(sessionId, {
			failures,
			after:
				Date.now() +
				Math.min(1_000 * 2 ** (failures - 1), BACKFILL_RETRY_MAX_MS) *
					(0.8 + Math.random() * 0.2),
		});
	}

	private shouldStartBackfill(sessionId: string, event: SSEEvent): boolean {
		if (this.syncedSessions.has(sessionId)) return false;
		const pendingAttempts = this.pendingAttempts.get(sessionId) ?? 0;
		const terminal = isSettlingEvent(event);
		if (terminal && this.backfillsInFlight.has(sessionId)) {
			this.terminalRecheckQueued.add(sessionId);
			return false;
		}
		if (pendingAttempts < BACKFILL_PENDING_MAX_ATTEMPTS) return true;
		if (!terminal || this.terminalRechecks.has(sessionId)) return false;
		this.terminalRechecks.add(sessionId);
		return true;
	}

	private invalidateHistory(sessionId: string): Effect.Effect<void, SqlError> {
		return this.withSql(
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql`UPDATE sessions SET history_complete = 0 WHERE id = ${sessionId}`,
			),
		).pipe(Effect.asVoid);
	}

	private refreshSyncedSession(
		sessionId: string,
		event: SSEEvent,
	): Effect.Effect<void, SqlError> {
		if (!this.syncedSessions.has(sessionId) || !isSettlingEvent(event))
			return Effect.void;
		return this.withSql(
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql<{ history_complete: number }>`
					SELECT history_complete FROM sessions WHERE id = ${sessionId}`,
			),
		).pipe(
			Effect.tap((rows) =>
				Effect.sync(() => {
					if (rows[0]?.history_complete !== 1)
						this.syncedSessions.delete(sessionId);
				}),
			),
			Effect.asVoid,
		);
	}

	private startBackfill(
		sessionId: string,
		providerInstanceId: string,
	): Effect.Effect<void> {
		if (
			this.stopped ||
			!this.fetchSessionMessages ||
			this.backfillsInFlight.has(sessionId)
		)
			return Effect.void;
		this.backfillsInFlight.add(sessionId);
		return Effect.gen(this, function* () {
			const retry = this.backfillRetries.get(sessionId);
			const delay = Math.max(0, (retry?.after ?? 0) - Date.now());
			const fiber = yield* Effect.gen(this, function* () {
				if (delay > 0) yield* Effect.sleep(delay);
				if (
					this.sessionInstanceIds.get(sessionId) !== providerInstanceId ||
					this.stopped
				)
					return;
				yield* this.backfill(
					sessionId,
					providerInstanceId,
					this.reconnectGenerations.get(providerInstanceId) ?? 0,
				);
			}).pipe(Effect.forkDaemon);
			if (this.backfillsInFlight.has(sessionId))
				this.backfillFibers.set(sessionId, fiber);
		});
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

	private backfill(
		sessionId: string,
		providerInstanceId: string,
		generation: number,
	): Effect.Effect<void> {
		const fetchSessionMessages = this.fetchSessionMessages;
		if (!fetchSessionMessages) return Effect.void;
		return Effect.gen(this, function* () {
			const historyRevision = this.historyRevisions.get(sessionId) ?? 0;
			yield* this.withSql(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`UPDATE sessions SET history_complete = 0 WHERE id = ${sessionId}`,
				),
			);
			const controller = new AbortController();
			this.backfillControllers.set(sessionId, controller);
			const rest = yield* this.backfillFetchPermits
				.withPermits(1)(
					fetchSessionMessages(
						sessionId,
						providerInstanceId,
						controller.signal,
					).pipe(
						Effect.timeoutFail({
							duration: BACKFILL_TIMEOUT,
							onTimeout: () => new Error(`timed out after ${BACKFILL_TIMEOUT}`),
						}),
					),
				)
				.pipe(
					Effect.ensuring(
						Effect.sync(() => {
							controller.abort();
							this.backfillControllers.delete(sessionId);
						}),
					),
				);
			if (
				this.stopped ||
				generation !== (this.reconnectGenerations.get(providerInstanceId) ?? 0)
			)
				return;
			yield* this.sessionGate(sessionId).withPermits(1)(
				this.applyBackfill(
					sessionId,
					rest,
					providerInstanceId,
					generation,
					historyRevision,
				),
			);
		}).pipe(
			Effect.catchAllCause((cause) =>
				Effect.sync(() => {
					if (
						this.stopped ||
						this.sessionInstanceIds.get(sessionId) !== providerInstanceId ||
						generation !==
							(this.reconnectGenerations.get(providerInstanceId) ?? 0)
					)
						return;
					this.pendingAttempts.set(
						sessionId,
						(this.pendingAttempts.get(sessionId) ?? 0) + 1,
					);
					this.deferBackfill(sessionId);
					this.log.warn(
						"opencode-runtime-ingress: history backfill failed, retry scheduled",
						{ sessionId, error: Cause.pretty(cause) },
					);
				}),
			),
			Effect.ensuring(
				Effect.gen(this, function* () {
					this.backfillsInFlight.delete(sessionId);
					this.backfillFibers.delete(sessionId);
					const current =
						this.reconnectGenerations.get(providerInstanceId) ?? 0;
					if (
						!this.stopped &&
						current !== generation &&
						this.sessionInstanceIds.get(sessionId) === providerInstanceId &&
						!this.syncedSessions.has(sessionId)
					) {
						this.backfillRetries.delete(sessionId);
						yield* this.startBackfill(sessionId, providerInstanceId);
					} else if (
						!this.stopped &&
						current === generation &&
						this.sessionInstanceIds.get(sessionId) === providerInstanceId &&
						!this.syncedSessions.has(sessionId) &&
						this.terminalRecheckQueued.has(sessionId) &&
						!this.terminalRechecks.has(sessionId) &&
						(this.pendingAttempts.get(sessionId) ?? 0) >=
							BACKFILL_PENDING_MAX_ATTEMPTS
					) {
						this.terminalRecheckQueued.delete(sessionId);
						this.terminalRechecks.add(sessionId);
						yield* this.startBackfill(sessionId, providerInstanceId);
					} else if (
						!this.stopped &&
						current === generation &&
						this.sessionInstanceIds.get(sessionId) === providerInstanceId &&
						!this.syncedSessions.has(sessionId) &&
						this.backfillRetries.has(sessionId) &&
						(this.pendingAttempts.get(sessionId) ?? 0) <
							BACKFILL_PENDING_MAX_ATTEMPTS
					) {
						yield* this.startBackfill(sessionId, providerInstanceId);
					}
				}),
			),
		);
	}

	private applyBackfill(
		sessionId: string,
		rest: readonly Message[],
		providerInstanceId: string,
		generation: number,
		historyRevision: number,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			if (
				this.stopped ||
				this.sessionInstanceIds.get(sessionId) !== providerInstanceId ||
				generation !==
					(this.reconnectGenerations.get(providerInstanceId) ?? 0) ||
				historyRevision !== (this.historyRevisions.get(sessionId) ?? 0)
			)
				return yield* Effect.die(new Error("stale OpenCode REST backfill"));
			const projected = yield* this.withSql(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql<StoredMessage>`SELECT id, rest_digest, rest_event_id FROM messages WHERE session_id = ${sessionId}`,
				),
			);
			const stored = new Map(projected.map((row) => [row.id, row]));
			const settled = rest.filter(isSettled);
			const digests = new Map(
				settled.map((message) => [message.id, snapshotPayload(message).digest]),
			);
			const events: ProviderRuntimeEvent[] = settled
				.filter(
					(message) =>
						stored.get(message.id)?.rest_digest !== digests.get(message.id),
				)
				.map((message) =>
					synthesizeSnapshotEvent(
						sessionId,
						message,
						stored.get(message.id)?.rest_event_id ?? undefined,
					),
				);
			if (events.length > 0) {
				this.log.info("opencode-runtime-ingress: reconciling REST history", {
					sessionId,
					events: events.length,
				});
			}
			let complete = false;
			yield* this.ingestion
				.ingestBatch(events, {
					publishToRelay: false,
					beforeCommit: this.withSql(
						Effect.gen(this, function* () {
							const sql = yield* SqlClient.SqlClient;
							const rows = yield* sql<StoredMessage>`
						SELECT id, rest_digest, rest_event_id FROM messages
						WHERE session_id = ${sessionId} ORDER BY created_at ASC, id ASC`;
							complete =
								rest.every(isSettled) &&
								rows.length === rest.length &&
								rows.every(
									(row, index) =>
										row.id === rest[index]?.id &&
										row.rest_digest !== null &&
										digests.get(row.id) === row.rest_digest,
								);
							// This flag caches the REST reconciliation proof. Rebuilding the
							// read model from events resets it to 0 until the next sighting.
							yield* sql`UPDATE sessions SET history_complete = ${complete ? 1 : 0} WHERE id = ${sessionId}`;
							if (
								this.stopped ||
								this.sessionInstanceIds.get(sessionId) !== providerInstanceId ||
								generation !==
									(this.reconnectGenerations.get(providerInstanceId) ?? 0) ||
								historyRevision !== (this.historyRevisions.get(sessionId) ?? 0)
							) {
								return yield* Effect.die(
									new Error("stale OpenCode REST backfill"),
								);
							}
						}),
					),
				})
				.pipe(Effect.withMaxOpsBeforeYield(Number.MAX_SAFE_INTEGER));
			if (
				!this.stopped &&
				this.sessionInstanceIds.get(sessionId) === providerInstanceId &&
				generation === (this.reconnectGenerations.get(providerInstanceId) ?? 0)
			) {
				if (!complete) {
					this.pendingAttempts.set(
						sessionId,
						(this.pendingAttempts.get(sessionId) ?? 0) + 1,
					);
					this.deferBackfill(sessionId);
				} else {
					this.syncedSessions.add(sessionId);
					this.pendingAttempts.delete(sessionId);
					this.terminalRechecks.delete(sessionId);
					this.terminalRecheckQueued.delete(sessionId);
					this.backfillRetries.delete(sessionId);
				}
			}
		});
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
			this.sessionInstanceIds.set(sessionId, providerInstanceId);
			const result = yield* this.sessionGate(sessionId).withPermits(1)(
				Effect.gen(this, function* () {
					const ingest = this.ingestSessionEvent(
						event,
						sessionId,
						providerInstanceId,
					);
					if (
						this.seenSessions.has(sessionId) ||
						(yield* this.hasProjectedSession(sessionId))
					)
						return yield* ingest;
					// Fork emits events before its HTTP response. Let command-owned
					// creation persist the complete row before first-sighting seeding.
					return yield* this.sessionCreationGate.withPermits(1)(ingest);
				}),
			);
			if (event.type === "session.deleted") this.removeSession(sessionId);
			return result;
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
			if (this.backfillsInFlight.has(sessionId)) {
				this.historyRevisions.set(
					sessionId,
					(this.historyRevisions.get(sessionId) ?? 0) + 1,
				);
			}
			const info =
				event.type === "session.created"
					? (event.properties as Record<string, unknown>)["info"]
					: undefined;
			if (
				typeof info === "object" &&
				info !== null &&
				"parentID" in info &&
				typeof info.parentID === "string"
			) {
				this.parentIds.set(sessionId, info.parentID);
			}
			const translation = this.translator.forkSession(sessionId);
			const translated = yield* Effect.try({
				try: () => this.translator.translateInto(event, sessionId, translation),
				catch: (cause) => cause,
			});

			if (!translated || translated.length === 0) {
				const invalidated =
					translation.droppedRewrite || event.type === "message.part.updated";
				if (invalidated) {
					yield* this.invalidateHistory(sessionId);
					this.syncedSessions.delete(sessionId);
				}
				// Nothing to persist, so nothing can roll back: whatever the
				// translator learned about this event stands.
				this.translator.commitSession(sessionId, translation);
				yield* this.refreshSyncedSession(sessionId, event);
				if (
					!invalidated &&
					event.type !== "session.deleted" &&
					this.fetchSessionMessages &&
					this.shouldStartBackfill(sessionId, event)
				) {
					if (!(yield* this.hasProjectedSession(sessionId))) {
						const parentId = this.parentIds.get(sessionId);
						const knownParentId =
							parentId && (yield* this.hasProjectedSession(parentId))
								? parentId
								: undefined;
						yield* this.ingestion.ingestBatch(
							[
								opencodeSessionCreatedRuntimeEvent(
									sessionId,
									providerInstanceId,
									knownParentId,
								),
							],
							{ publishToRelay: false },
						);
						this.seenSessions.add(sessionId);
						this.parentIds.delete(sessionId);
					}
					yield* this.startBackfill(sessionId, providerInstanceId);
				}
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
			// The parent is kept only once it is a row: sessions.parent_id is a
			// foreign key, and an unknown parent would fail the batch forever.
			const parentId = this.parentIds.get(sessionId);
			const knownParentId =
				shouldAppendSessionCreation &&
				parentId !== undefined &&
				(yield* this.hasProjectedSession(parentId))
					? parentId
					: undefined;
			const runtimeEvents: ProviderRuntimeEvent[] = [
				...(shouldAppendSessionCreation
					? [
							opencodeSessionCreatedRuntimeEvent(
								sessionId,
								providerInstanceId,
								knownParentId,
							),
						]
					: []),
				...translated,
			];
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
				...(translation.droppedRewrite
					? { beforeCommit: this.invalidateHistory(sessionId) }
					: {}),
				afterCommit: Effect.sync(() => {
					this.translator.commitSession(sessionId, translation);
					if (translation.droppedRewrite) this.syncedSessions.delete(sessionId);
					this.seenSessions.add(sessionId);
					this.parentIds.delete(sessionId);
				}),
			});

			yield* this.refreshSyncedSession(sessionId, event);
			if (
				!translation.droppedRewrite &&
				this.shouldStartBackfill(sessionId, event)
			)
				yield* this.startBackfill(sessionId, providerInstanceId);

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

	/** The SSE callback is synchronous. A stale REST result cannot mark a
	 *  reconnected session complete; live commits never wait for that result. */
	onReconnect(providerInstanceId?: string): Effect.Effect<void, SqlError> {
		this.translator.resetAnnouncements();
		// Events may have been missed while disconnected, even for idle sessions.
		const instances =
			providerInstanceId === undefined
				? new Set(this.sessionInstanceIds.values())
				: new Set([providerInstanceId]);
		for (const instanceId of instances) {
			this.reconnectGenerations.set(
				instanceId,
				(this.reconnectGenerations.get(instanceId) ?? 0) + 1,
			);
		}
		for (const [sessionId, instanceId] of this.sessionInstanceIds) {
			if (instances.has(instanceId)) {
				this.syncedSessions.delete(sessionId);
				this.backfillRetries.delete(sessionId);
				this.pendingAttempts.delete(sessionId);
				this.terminalRechecks.delete(sessionId);
				this.terminalRecheckQueued.delete(sessionId);
			}
		}
		this.log.info("opencode-runtime-ingress: translator reset on reconnect");
		return this.withSql(
			Effect.gen(this, function* () {
				const sql = yield* SqlClient.SqlClient;
				for (const [sessionId, instanceId] of this.sessionInstanceIds) {
					if (!instances.has(instanceId)) continue;
					yield* this.sessionGate(sessionId).withPermits(1)(
						Effect.gen(this, function* () {
							if (this.sessionInstanceIds.get(sessionId) !== instanceId) return;
							yield* sql`UPDATE sessions SET history_complete = 0 WHERE id = ${sessionId}`;
							yield* this.startBackfill(sessionId, instanceId);
						}),
					);
				}
			}),
		);
	}

	reconcileSession(sessionId: string): Effect.Effect<void> {
		return this.withSql(
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql<{
						provider: string | null;
					}>`SELECT provider FROM sessions WHERE id = ${sessionId}`,
			),
		).pipe(
			Effect.flatMap((rows) => {
				const instanceId = rows[0]?.provider;
				if (!instanceId) return Effect.void;
				this.sessionInstanceIds.set(sessionId, instanceId);
				return this.startBackfill(sessionId, instanceId);
			}),
			Effect.catchAll(() => Effect.void),
		);
	}

	private removeSession(sessionId: string): void {
		this.backfillFibers.get(sessionId)?.unsafeInterruptAsFork(FiberId.none);
		this.backfillFibers.delete(sessionId);
		this.backfillControllers.get(sessionId)?.abort();
		this.backfillControllers.delete(sessionId);
		this.backfillsInFlight.delete(sessionId);
		this.historyRevisions.delete(sessionId);
		this.backfillRetries.delete(sessionId);
		this.pendingAttempts.delete(sessionId);
		this.terminalRechecks.delete(sessionId);
		this.terminalRecheckQueued.delete(sessionId);
		this.syncedSessions.delete(sessionId);
		this.seenSessions.delete(sessionId);
		this.parentIds.delete(sessionId);
		this.sessionGates.delete(sessionId);
		const instanceId = this.sessionInstanceIds.get(sessionId);
		this.sessionInstanceIds.delete(sessionId);
		if (
			instanceId &&
			![...this.sessionInstanceIds.values()].includes(instanceId)
		) {
			this.reconnectGenerations.delete(instanceId);
		}
	}

	isHistoryComplete(sessionId: string): Effect.Effect<boolean> {
		if (!this.syncedSessions.has(sessionId)) return Effect.succeed(false);
		return this.withSql(
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql<{ history_complete: number }>`
					SELECT history_complete FROM sessions WHERE id = ${sessionId}`,
			),
		).pipe(
			Effect.map((rows) => rows[0]?.history_complete === 1),
			Effect.catchAll(() => Effect.succeed(false)),
		);
	}

	shutdown(): void {
		this.stopped = true;
		for (const fiber of this.backfillFibers.values())
			fiber.unsafeInterruptAsFork(FiberId.none);
		this.backfillFibers.clear();
		for (const controller of this.backfillControllers.values())
			controller.abort();
		this.backfillControllers.clear();
		this.backfillsInFlight.clear();
		this.backfillRetries.clear();
		this.pendingAttempts.clear();
		this.terminalRechecks.clear();
		this.terminalRecheckQueued.clear();
		this.sessionInstanceIds.clear();
		this.reconnectGenerations.clear();
		this.sessionGates.clear();
		this.parentIds.clear();
		this.seenSessions.clear();
		this.syncedSessions.clear();
		this.stopStatsLogging();
	}

	getStats(): Readonly<OpenCodeRuntimeIngressStats> {
		return { ...this.stats };
	}

	startStatsLogging(intervalMs = 60_000): void {
		this.stopStatsLogging();
		this.statsIntervalId = setInterval(() => {
			const stats = this.stats;
			this.log.info("opencode-runtime-ingress stats", {
				eventsReceived: stats.eventsReceived,
				eventsWritten: stats.eventsWritten,
				eventsSkipped: stats.eventsSkipped,
				errors: stats.errors,
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
	fetchSessionMessages?: EffectOpenCodeRuntimeIngressOptions["fetchSessionMessages"],
	inputIdForUserEcho?: EffectOpenCodeRuntimeIngressOptions["inputIdForUserEcho"],
): Effect.Effect<
	EffectOpenCodeRuntimeIngress,
	ProjectionRunnerError | SqlError,
	SqlClient.SqlClient | ProjectionRunnerEffectTag | ProviderRuntimeIngestionTag
> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const creationGate = yield* Effect.serviceOption(
			OpenCodeSessionCreationGateTag,
		);
		const ingress = new EffectOpenCodeRuntimeIngress({
			sql,
			projectionRunner,
			ingestion,
			log,
			...(creationGate._tag === "Some"
				? { sessionCreationGate: creationGate.value }
				: {}),
			...(fetchSessionMessages ? { fetchSessionMessages } : {}),
			...(inputIdForUserEcho ? { inputIdForUserEcho } : {}),
		});
		yield* ingress.recoverEffect();
		// Reconciliation proof is valid only for the process that fetched REST.
		yield* sql`UPDATE sessions SET history_complete = 0`;
		return ingress;
	});
