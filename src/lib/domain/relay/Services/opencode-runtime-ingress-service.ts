import { randomUUID } from "node:crypto";
import { Context, Effect, type Fiber, References, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../contracts/provider-instance.js";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import * as Failure from "../../../effect/failure-classification.js";
import { formatErrorDetail, OpenCodeApiError } from "../../../errors.js";
import type { Message, SessionStatus } from "../../../instance/sdk-types.js";
import { ClaudeEventPersistEffectTag } from "../../../persistence/effect/claude-event-persist-effect.js";
import { requeueFailedSteers } from "../../../persistence/effect/input-requeue-effect.js";
import {
	type ProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
	type ProjectionRunnerError,
} from "../../../persistence/effect/projection-runner-effect.js";
import { runTerminalStatus } from "../../../persistence/effect/projectors-effect.js";
import { isSessionDeleted } from "../../../persistence/effect/session-seeder-effect.js";
import { createEventId } from "../../../persistence/events.js";
import {
	completedCompactionEvent,
	isSettled,
	snapshotPayload,
	synthesizeSnapshotEvent,
} from "../../../provider/opencode/opencode-history-backfill.js";
import {
	inputIdFromOpenCodeMessageId,
	openCodeInputMessageId,
} from "../../../provider/opencode/opencode-input-message-id.js";
import {
	OpenCodeRuntimeEventTranslator,
	opencodeSessionCreatedRuntimeEvent,
} from "../../../provider/opencode/opencode-runtime-event-translator.js";
import type { runningRunnerCommands } from "../../../provider/runner/runner-recovery.js";
import { settleSessionRuns } from "../../../provider/session-run-settlement.js";
import type { TurnSettings } from "../../../provider/turn-settings.js";
import {
	isPartUpdatedEvent,
	type SSEEvent,
} from "../../../relay/opencode-events.js";
import type { OpenCodeEventContext } from "../../../relay/sse-stream.js";
import { isRecord } from "../../../utils.js";
import { PersistenceProjectTag } from "../../persistence/Services/persistence-service.js";
import {
	canSeedSession,
	type ProviderRuntimeIngestion,
	type ProviderRuntimeIngestionError,
	ProviderRuntimeIngestionTag,
} from "./provider-runtime-ingestion-service.js";
import { ConfigTag, SessionRetriesTag } from "./services.js";
import type { TurnFailureOwner } from "./turn-failure.js";

export interface OpenCodeRuntimeIngressLog {
	warn(msg: string, context?: Record<string, unknown>): void;
	debug(msg: string, context?: Record<string, unknown>): void;
	info(msg: string, context?: Record<string, unknown>): void;
	verbose(msg: string, context?: Record<string, unknown>): void;
}

export type OpenCodeRuntimeIngressResult =
	| {
			ok: true;
			eventsWritten: number;
			sessionSeeded: boolean;
			prompt?: { readonly id: string; readonly status: string };
	  }
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
		context?: OpenCodeEventContext,
	): Effect.Effect<OpenCodeRuntimeIngressResult>;
	onReconnect(providerInstanceId?: string): Effect.Effect<void, SqlError>;
	onInstanceStopped(
		providerInstanceId: string,
		isCurrent: () => boolean,
	): Effect.Effect<void>;
	reconcileSession(sessionId: string): Effect.Effect<void>;
	shutdown(): void;
	isHistoryComplete(sessionId: string): Effect.Effect<boolean>;
	getStats(): Readonly<OpenCodeRuntimeIngressStats>;
	startStatsLogging(intervalMs?: number): void;
	stopStatsLogging(): void;
}

export class OpenCodeHistoryReconcileTag extends Context.Service<
	OpenCodeHistoryReconcileTag,
	{ reconcileSession(sessionId: string): Effect.Effect<void> }
>()("OpenCodeHistoryReconcile") {}

export class OpenCodeSessionCreationGateTag extends Context.Service<
	OpenCodeSessionCreationGateTag,
	Semaphore.Semaphore
>()("OpenCodeSessionCreationGate") {}

export interface EffectOpenCodeRuntimeIngressOptions {
	readonly projectId: string;
	readonly sql: SqlClient.SqlClient;
	readonly projectionRunner: ProjectionRunnerEffect;
	readonly ingestion: ProviderRuntimeIngestion;
	readonly log: OpenCodeRuntimeIngressLog;
	readonly sessionCreationGate?: Semaphore.Semaphore;
	/** The provider's REST record of a session, for the first-sighting history
	 *  backfill. Without it a session projects only what Conduit observes. */
	readonly fetchSessionMessages?: (
		sessionId: string,
		providerInstanceId: string,
		signal: AbortSignal,
		directory?: string,
	) => Effect.Effect<readonly Message[], unknown>;
	/** The send a user message echo belongs to, from the OpenCode adapter. */
	readonly inputIdForUserEcho?: (
		sessionId: string,
		messageId: string,
		compaction?: boolean,
	) => string | undefined;
	readonly retryingOf?: (sessionId: string) => string | undefined;
	readonly backfillRetryDelayMs?: number;
	/** The default OpenCode binding aliases this relay's selected instance. */
	readonly selectedInstanceId?: string;
	readonly resolveSessionPick?: (
		providerInstanceId: string,
		parentId?: string,
	) => Effect.Effect<TurnSettings | undefined>;
}

const BACKFILL_TIMEOUT = "15 seconds";
const BACKFILL_RETRY_MAX_MS = 30_000;
const BACKFILL_CONCURRENCY = 4;
const BACKFILL_PENDING_MAX_ATTEMPTS = 3;

type StoredMessage = {
	id: string;
	is_inherited: number;
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
	private readonly projectId: string;
	private readonly projectionRunner: ProjectionRunnerEffect;
	private readonly ingestion: ProviderRuntimeIngestion;
	private readonly retryingOf:
		| EffectOpenCodeRuntimeIngressOptions["retryingOf"]
		| undefined;
	private readonly log: OpenCodeRuntimeIngressLog;
	private readonly backfillRetryDelayMs: number;
	private readonly selectedInstanceId: string;
	private readonly resolveSessionPick:
		| EffectOpenCodeRuntimeIngressOptions["resolveSessionPick"]
		| undefined;
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
	private readonly sessionGates = new Map<string, Semaphore.Semaphore>();
	private readonly sessionCreationGate: Semaphore.Semaphore;
	private readonly backfillFetchPermits =
		Semaphore.makeUnsafe(BACKFILL_CONCURRENCY);
	/** Sessions whose history was reconciled with the provider's REST record
	 *  since the stream last (re)connected. Unlike seenSessions it is cleared
	 *  on reconnect, so the next event of each session backfills the gap. */
	private readonly syncedSessions = new Set<string>();
	private readonly sessionInstanceIds = new Map<string, string>();
	/** First-sighting REST reads precede the stored workspace; retries keep the
	 *  observed directory only while the same instance owns the session. */
	private readonly sessionDirectories = new Map<
		string,
		{ readonly instanceId: string; readonly directory: string }
	>();
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
	private readonly backfillFibers = new Map<string, Fiber.Fiber<void, never>>();

	private stats: OpenCodeRuntimeIngressStats = {
		eventsReceived: 0,
		eventsWritten: 0,
		eventsSkipped: 0,
		errors: 0,
	};

	private statsIntervalId: ReturnType<typeof setInterval> | undefined;

	constructor(opts: EffectOpenCodeRuntimeIngressOptions) {
		this.sql = opts.sql;
		this.projectId = opts.projectId;
		this.projectionRunner = opts.projectionRunner;
		this.ingestion = opts.ingestion;
		this.retryingOf = opts.retryingOf;
		this.log = opts.log;
		this.backfillRetryDelayMs = opts.backfillRetryDelayMs ?? 1_000;
		this.resolveSessionPick = opts.resolveSessionPick;
		this.selectedInstanceId =
			opts.selectedInstanceId ?? MANAGED_OPENCODE_ACCOUNT_ID;
		this.sessionCreationGate =
			opts.sessionCreationGate ?? Semaphore.makeUnsafe(1);
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

	/** Resolve live OpenCode ownership from its accepted user echo and explicit message parents. */
	private ownRunEvents(events: readonly ProviderRuntimeEvent[]) {
		return Effect.gen({ self: this }, function* () {
			const output: ProviderRuntimeEvent[] = [];
			const active = new Map<string, string | undefined>();
			const messageRuns = new Map<string, string>();
			for (const event of events) {
				if (event.runId || event.rawSource.kind === "opencode.rest") {
					output.push(event);
					continue;
				}
				const sessionId = event.sessionId;
				if (!active.has(sessionId)) {
					const rows = yield* this.sql<{
						id: string;
					}>`SELECT id FROM provider_runs
						WHERE session_id = ${sessionId} AND status = 'running'`;
					active.set(sessionId, rows.length === 1 ? rows[0]?.id : undefined);
				}
				const data = event.data as Record<string, unknown>;
				const messageId =
					typeof data["messageId"] === "string" ? data["messageId"] : undefined;
				let runId: string | undefined;
				let accepted: ProviderRuntimeEvent | undefined;
				let acceptedInputId: string | undefined;
				if (
					event.type === "message.created" &&
					data["role"] === "user" &&
					messageId
				) {
					const inputId =
						typeof data["inputId"] === "string"
							? data["inputId"]
							: inputIdFromOpenCodeMessageId(messageId);
					if (inputId) {
						const [request] = yield* this.sql<{
							run_id: string;
							status: string;
							accepted_run_id: string | null;
						}>`SELECT r.id AS run_id, r.status,
							CASE WHEN r.joined_into IS NOT NULL THEN r.joined_into
								WHEN r.started_at IS NOT NULL THEN r.id END AS accepted_run_id
							FROM provider_command_outbox o JOIN provider_runs r ON r.id = o.run_id
							WHERE o.session_id = ${sessionId} AND o.command_id = ${inputId}
							AND o.effect_type = 'send_turn' ORDER BY o.request_sequence DESC LIMIT 1`;
						if (request?.run_id) {
							acceptedInputId = inputId;
							runId =
								request.accepted_run_id ??
								(request.status === "pending"
									? (active.get(sessionId) ?? request.run_id)
									: request.run_id);
							if (!request.accepted_run_id && request.status !== "joined") {
								if (
									request.status === "pending" ||
									request.status === "running"
								)
									active.set(sessionId, runId);
								accepted = {
									...event,
									eventId: createEventId(),
									type: "run.started",
									runId,
									data: { inputId, requestedRunId: request.run_id },
								};
							}
						}
					} else if (
						inputId === undefined &&
						event.rawSource.kind === "opencode.sse" &&
						data["backfilled"] !== true
					) {
						const created = event.metadata?.["providerCreatedAt"];
						const inherited =
							created === undefined
								? []
								: yield* this.sql`
							SELECT 1 FROM sessions WHERE id = ${sessionId}
							AND (${created}, ${messageId}) <= (fork_point_timestamp,
								COALESCE(fork_point_message_id, fork_point_event, ''))`;
						if (inherited.length) {
							output.push(event);
							continue;
						}
						const [prior] = yield* this.sql<{
							run_id: string | null;
						}>`SELECT json_extract(metadata, '$.runId') AS run_id FROM events
							WHERE session_id = ${sessionId} AND type = 'run.started'
								AND json_extract(data, '$.inputId') = ${messageId}
							ORDER BY sequence LIMIT 1`;
						runId = prior?.run_id ?? active.get(sessionId) ?? randomUUID();
						if (!prior?.run_id) {
							active.set(sessionId, runId);
							accepted = {
								...event,
								eventId: createEventId(),
								type: "run.started",
								runId,
								data: { inputId: messageId, requestedRunId: runId },
							};
						}
					}
				} else if (messageId) {
					runId = messageRuns.get(messageId);
					const parentId =
						typeof data["parentID"] === "string" ? data["parentID"] : undefined;
					if (!runId && parentId) runId = messageRuns.get(parentId);
					if (!runId) {
						const [owner] = yield* this.sql<{
							run_id: string | null;
						}>`SELECT turns.run_id FROM messages
							JOIN turns ON turns.id = COALESCE(messages.turn_id, messages.id)
							WHERE messages.session_id = ${sessionId} AND messages.id = ${parentId ?? messageId}`;
						runId = owner?.run_id ?? undefined;
					}
				} else if (
					event.type === "session.status" ||
					event.type === "session.compaction" ||
					event.type === "turn.error" ||
					event.type.startsWith("permission.") ||
					event.type.startsWith("question.")
				) {
					runId = active.get(sessionId);
				}
				if (runId && messageId) messageRuns.set(messageId, runId);
				if (acceptedInputId && event.type === "message.created")
					output.push({
						...event,
						...(runId ? { runId } : {}),
						data: { ...data, inputId: acceptedInputId },
					});
				else output.push(runId ? { ...event, runId } : event);
				if (accepted) output.push(accepted);
				if (
					runId &&
					active.get(sessionId) === runId &&
					(event.type === "turn.error" ||
						(event.type === "session.status" &&
							(data["status"] === "idle" || data["status"] === "error")))
				)
					active.set(sessionId, undefined);
			}
			return output;
		});
	}

	private ingestBatch(
		events: readonly ProviderRuntimeEvent[],
		options?: Parameters<ProviderRuntimeIngestion["ingestBatch"]>[1],
	): Effect.Effect<number, ProviderRuntimeIngestionError> {
		return Effect.gen({ self: this }, function* () {
			const picks = new Map<string, TurnSettings>();
			for (const event of events) {
				if (event.type !== "session.created" || !this.resolveSessionPick)
					continue;
				const data = event.data as { provider: string; parentId?: string };
				const pick = yield* this.resolveSessionPick(
					data.provider,
					data.parentId,
				);
				if (pick) picks.set(event.sessionId, pick);
			}
			const owned = yield* this.ownRunEvents(
				events.map((event) => {
					const directory = this.sessionDirectories.get(event.sessionId);
					return event.type === "session.created" && directory
						? {
								...event,
								metadata: {
									...event.metadata,
									nativeDirectory: directory.directory,
								},
							}
						: event;
				}),
			);
			return yield* this.ingestion.ingestBatch(owned, {
				...options,
				sessionPicks: picks,
			});
		});
	}

	private sessionGate(sessionId: string): Semaphore.Semaphore {
		const existing = this.sessionGates.get(sessionId);
		if (existing) return existing;
		const gate = Semaphore.makeUnsafe(1);
		this.sessionGates.set(sessionId, gate);
		return gate;
	}

	private instanceIdentity(instanceId: string): string {
		return instanceId === MANAGED_OPENCODE_ACCOUNT_ID
			? this.selectedInstanceId
			: instanceId;
	}

	private rememberSessionInstance(
		sessionId: string,
		providerInstanceId: string,
		directory?: string,
	): void {
		const instanceId = this.instanceIdentity(providerInstanceId);
		if (this.sessionDirectories.get(sessionId)?.instanceId !== instanceId)
			this.sessionDirectories.delete(sessionId);
		if (directory !== undefined)
			this.sessionDirectories.set(sessionId, { instanceId, directory });
		this.sessionInstanceIds.set(sessionId, providerInstanceId);
	}

	private deferBackfill(sessionId: string): void {
		const failures = (this.backfillRetries.get(sessionId)?.failures ?? 0) + 1;
		this.backfillRetries.set(sessionId, {
			failures,
			after:
				Date.now() +
				Math.min(
					this.backfillRetryDelayMs * 2 ** (failures - 1),
					BACKFILL_RETRY_MAX_MS,
				) *
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
					sql`UPDATE sessions SET history_complete = 0
						WHERE id = ${sessionId} AND project_id = ${this.projectId}`,
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
					SELECT history_complete FROM sessions
					WHERE id = ${sessionId} AND project_id = ${this.projectId}`,
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
		return Effect.gen({ self: this }, function* () {
			const retry = this.backfillRetries.get(sessionId);
			const delay = Math.max(0, (retry?.after ?? 0) - Date.now());
			const fiber = yield* Effect.gen({ self: this }, function* () {
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
			}).pipe(Effect.forkDetach({ uninterruptible: "inherit" }));
			if (this.backfillsInFlight.has(sessionId))
				this.backfillFibers.set(sessionId, fiber);
		});
	}

	private hasProjectedSession(sessionId: string): Effect.Effect<boolean> {
		return this.withSql(
			Effect.gen({ self: this }, function* () {
				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<{ id: string }>`
					SELECT id FROM sessions
					WHERE id = ${sessionId} AND project_id = ${this.projectId}
					LIMIT 1`;
				return rows.length > 0;
			}),
		).pipe(Effect.catchCause(() => Effect.succeed(false)));
	}

	private backfill(
		sessionId: string,
		providerInstanceId: string,
		generation: number,
	): Effect.Effect<void> {
		const fetchSessionMessages = this.fetchSessionMessages;
		if (!fetchSessionMessages) return Effect.void;
		return Effect.gen({ self: this }, function* () {
			const historyRevision = this.historyRevisions.get(sessionId) ?? 0;
			yield* this.withSql(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`UPDATE sessions SET history_complete = 0
							WHERE id = ${sessionId} AND project_id = ${this.projectId}`,
				),
			);
			const controller = new AbortController();
			this.backfillControllers.set(sessionId, controller);
			const rest = yield* this.backfillFetchPermits
				.withPermits(1)(
					Effect.suspend(() => {
						if (
							this.stopped ||
							this.sessionInstanceIds.get(sessionId) !== providerInstanceId ||
							generation !==
								(this.reconnectGenerations.get(providerInstanceId) ?? 0)
						)
							return Effect.interrupt;
						const observed = this.sessionDirectories.get(sessionId);
						return fetchSessionMessages(
							sessionId,
							providerInstanceId,
							controller.signal,
							observed?.instanceId === this.instanceIdentity(providerInstanceId)
								? observed.directory
								: undefined,
						);
					}).pipe(
						Effect.timeoutOrElse({
							duration: BACKFILL_TIMEOUT,
							orElse: () =>
								Effect.fail(new Error(`timed out after ${BACKFILL_TIMEOUT}`)),
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
			Effect.catchCause((cause) =>
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
						{ sessionId, error: Failure.renderCause(cause) },
					);
				}),
			),
			Effect.ensuring(
				Effect.gen({ self: this }, function* () {
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
		options?: {
			beforeCommit: Effect.Effect<void, SqlError>;
			completeHistory: boolean;
			restoreTurns: boolean;
		},
	): Effect.Effect<void, unknown> {
		return Effect.gen({ self: this }, function* () {
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
						sql<StoredMessage>`SELECT id, is_inherited, rest_digest, rest_event_id FROM messages WHERE session_id = ${sessionId}`,
				),
			);
			// Native forks can arrive before their boundary row is projected. Resolve
			// the copied provider history once per REST batch, then persist the fact.
			const [fork] = yield* this.sql<{
				fork_point_event: string | null;
				fork_point_timestamp: number | null;
			}>`
				SELECT fork_point_event, fork_point_timestamp FROM sessions WHERE id = ${sessionId}`;
			const boundary = rest.find(({ id }) => id === fork?.fork_point_event);
			const boundaryTime =
				boundary?.time?.created ?? fork?.fork_point_timestamp;
			const inherited = new Set(
				rest
					.filter((message) => {
						const created = message.time?.created;
						return (
							boundaryTime != null &&
							created != null &&
							(created < boundaryTime ||
								(created === boundaryTime &&
									message.id <= (fork?.fork_point_event ?? "")))
						);
					})
					.map(({ id }) => id),
			);
			const stored = new Map(projected.map((row) => [row.id, row]));
			const settled = rest.filter(isSettled);
			const digests = new Map(
				settled.map((message) => [message.id, snapshotPayload(message).digest]),
			);
			const events: ProviderRuntimeEvent[] = settled
				.filter(
					(message) =>
						// A busy sample before the next user echo can reopen the
						// previous turn and clear its reply link. Reproject its owned
						// history during recovery even when the snapshot is unchanged.
						options?.restoreTurns ||
						stored.get(message.id)?.rest_digest !== digests.get(message.id) ||
						(inherited.has(message.id) &&
							stored.get(message.id)?.is_inherited !== 1),
				)
				.map((message) => {
					const snapshot = synthesizeSnapshotEvent(
						sessionId,
						message,
						stored.get(message.id)?.rest_event_id ?? undefined,
					);
					return inherited.has(message.id)
						? {
								...snapshot,
								eventId: `${snapshot.eventId}_inherited`,
								metadata: { inherited: true },
							}
						: snapshot;
				});
			// Even an unchanged snapshot may predate compaction ingestion. Always
			// offer the summary outcome; append deduplicates its durable message ID.
			for (const message of settled) {
				const compaction = completedCompactionEvent(sessionId, message, {
					kind: "opencode.rest",
					endpoint: "session.messages",
				});
				if (compaction) events.push(compaction);
			}
			if (events.length > 0) {
				if (!(yield* this.hasProjectedSession(sessionId))) {
					const parentId = this.parentIds.get(sessionId);
					const knownParentId =
						parentId &&
						((yield* this.hasProjectedSession(parentId)) ||
							(yield* this.withSql(isSessionDeleted(parentId))))
							? parentId
							: undefined;
					events.unshift(
						opencodeSessionCreatedRuntimeEvent(
							sessionId,
							providerInstanceId,
							knownParentId,
						),
					);
				}
				this.log.info("opencode-runtime-ingress: reconciling REST history", {
					sessionId,
					events: events.length,
				});
			}
			let complete = false;
			yield* this.ingestBatch(events, {
				publishToRelay: false,
				beforeCommit: this.withSql(
					Effect.gen({ self: this }, function* () {
						yield* options?.beforeCommit ?? Effect.void;
						const sql = yield* SqlClient.SqlClient;
						const rows = yield* sql<StoredMessage>`
						SELECT id, rest_digest, rest_event_id FROM messages
						WHERE session_id = ${sessionId} ORDER BY created_at ASC, id ASC`;
						complete =
							(options?.completeHistory ?? true) &&
							(yield* this.hasProjectedSession(sessionId)) &&
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
						yield* sql`UPDATE sessions SET history_complete = ${complete ? 1 : 0}
							WHERE id = ${sessionId} AND project_id = ${this.projectId}`;
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
			}).pipe(
				Effect.provideService(
					References.MaxOpsBeforeYield,
					Number.MAX_SAFE_INTEGER,
				),
			);
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

	/** Freeze outstanding accepted startup runs before probing. An outbox may
	 * have completed just before its final owned idle event was committed. */
	recoverObservedRuns(
		readStatuses: (
			instanceId: string,
			sessionId: string,
		) => Effect.Effect<
			Record<string, SessionStatus> | "stopped" | undefined,
			unknown
		>,
		instanceIds: readonly string[] = [
			MANAGED_OPENCODE_ACCOUNT_ID,
			this.selectedInstanceId,
		],
	): Effect.Effect<void> {
		let pending:
			| Map<string, { instanceId: string; runIds: string[] }>
			| undefined;
		const gate = Semaphore.makeUnsafe(1);
		return gate
			.withPermitsIfAvailable(1)(
				Effect.gen({ self: this }, function* () {
					if (this.stopped) return;
					if (!pending) {
						const observed = yield* this.sql<{
							session_id: string;
							provider: string;
							id: string;
						}>`
					SELECT r.session_id, s.provider, r.id FROM provider_runs r JOIN sessions s ON s.id = r.session_id
					WHERE s.project_id = ${this.projectId} AND s.provider IN ${this.sql.in(instanceIds)}
					AND r.status IN ('pending', 'running') AND (r.status = 'running' OR NOT EXISTS (
						SELECT 1 FROM events WHERE session_id = s.id AND type = 'run.requested'
						AND json_extract(data, '$.runId') = r.id))`;
						pending = new Map();
						for (const row of observed) {
							const session = pending.get(row.session_id) ?? {
								instanceId: row.provider,
								runIds: [],
							};
							session.runIds.push(row.id);
							pending.set(row.session_id, session);
						}
					}
					for (const [sessionId, { instanceId, runIds }] of pending) {
						yield* Effect.gen({ self: this }, function* () {
							const outstanding = yield* this
								.sql`SELECT 1 FROM provider_runs WHERE session_id = ${sessionId}
						AND id IN ${this.sql.in(runIds)} AND status IN ('pending', 'running')`;
							if (!outstanding.length) {
								pending?.delete(sessionId);
								return;
							}
							const generation = this.reconnectGenerations.get(instanceId) ?? 0;
							const revision = this.historyRevisions.get(sessionId) ?? 0;
							const [snapshot] = yield* this.sql<{
								sequence: number;
							}>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE session_id = ${sessionId}`;
							const statuses = yield* readStatuses(instanceId, sessionId).pipe(
								Effect.timeout(BACKFILL_TIMEOUT),
							);
							if (
								!statuses ||
								(statuses !== "stopped" && statuses[sessionId]?.type !== "idle")
							)
								return;
							yield* this.sessionGate(sessionId).withPermits(1)(
								Effect.gen({ self: this }, function* () {
									const current = Effect.gen({ self: this }, function* () {
										if (
											this.stopped ||
											revision !==
												(this.historyRevisions.get(sessionId) ?? 0) ||
											generation !==
												(this.reconnectGenerations.get(instanceId) ?? 0)
										)
											return yield* Effect.interrupt;
										const [binding] = yield* this
											.sql`SELECT 1 FROM sessions s WHERE s.id = ${sessionId}
								AND s.project_id = ${this.projectId} AND s.provider = ${instanceId}
								AND (SELECT COALESCE(MAX(sequence), 0) FROM events WHERE session_id = s.id) = ${snapshot?.sequence ?? 0}`;
										if (!binding) return yield* Effect.interrupt;
									});
									yield* current;
									// The probe confirms the whole session stopped. Include all
									// outstanding runs from this unchanged snapshot, not just the
									// external input which made recovery necessary.
									yield* settleSessionRuns(
										this.sql,
										sessionId,
										statuses === "stopped"
											? "OpenCode instance stopped during daemon downtime"
											: "OpenCode session idle after daemon downtime",
										(events) =>
											this.ingestion.ingestBatch(events, {
												beforeProject: current,
											}),
									);
									pending?.delete(sessionId);
								}),
							);
						}).pipe(
							Effect.catchCause((cause) =>
								Failure.isInterruptedOnly(cause)
									? Effect.void
									: Effect.sync(() =>
											this.log.warn("Observed OpenCode run recovery deferred", {
												sessionId,
												error: Failure.renderCause(cause),
											}),
										),
							),
						);
					}
				}),
			)
			.pipe(
				Effect.asVoid,
				Effect.catch((cause) =>
					Effect.sync(() =>
						this.log.warn("Observed OpenCode startup recovery deferred", {
							error: formatErrorDetail(cause),
						}),
					),
				),
			);
	}

	/** Recover only startup claims, without executing their prompts again. The
	 * existing status poller retries unavailable providers and stale REST reads. */
	recoverCommands(
		commands: Effect.Success<ReturnType<typeof runningRunnerCommands>>,
		readStatuses: (
			instanceId: string,
			sessionId: string,
		) => Effect.Effect<
			Record<string, SessionStatus> | "stopped" | undefined,
			unknown
		>,
		failTurn: (
			sessionId: string,
			error: string,
			code: string,
			owner: TurnFailureOwner,
			options?: {
				beforeCommit?: Effect.Effect<void, SqlError>;
				beforeProject?: Effect.Effect<void, SqlError>;
				settleSession?: boolean;
			},
		) => Effect.Effect<void>,
	): Effect.Effect<void> {
		const pending = new Set(commands);
		const gate = Semaphore.makeUnsafe(1);
		return gate
			.withPermitsIfAvailable(1)(
				Effect.forEach(
					pending,
					(command) =>
						Effect.gen({ self: this }, function* () {
							if (this.stopped || !this.fetchSessionMessages) return;
							const sessionId = command.session_id;
							const instanceId = command.provider_id;
							const requeue = Effect.gen({ self: this }, function* () {
								const persist = yield* Effect.serviceOption(
									ClaudeEventPersistEffectTag,
								);
								if (persist._tag === "Some")
									yield* requeueFailedSteers(
										this.sql,
										persist.value,
										sessionId,
										command.command_id,
									);
							});
							const [claim] = yield* this.sql<{
								request_sequence: number;
								latest_sequence: number;
								latest_active_sequence: number;
								user_message_id: string;
								provider: string;
								run_id: string | null;
							}>`SELECT outbox.request_sequence, sessions.provider,
								COALESCE((SELECT COALESCE(joined_into, id) FROM provider_runs
									WHERE session_id = outbox.session_id AND id = outbox.run_id),
									outbox.run_id) AS run_id,
								(SELECT MAX(request_sequence) FROM provider_command_outbox WHERE session_id = ${sessionId} AND effect_type = 'send_turn') AS latest_sequence,
								(SELECT MAX(request_sequence) FROM provider_command_outbox WHERE session_id = ${sessionId} AND effect_type = 'send_turn' AND status NOT IN ('completed', 'failed')) AS latest_active_sequence,
								COALESCE(
									(SELECT id FROM messages WHERE session_id = ${sessionId} AND input_id = ${command.command_id} AND role = 'user'),
									(SELECT user_message_id FROM turns WHERE session_id = ${sessionId} AND user_message_id = ${command.user_message_id}),
									${openCodeInputMessageId(command.user_message_id ?? command.command_id)}) AS user_message_id
								FROM provider_command_outbox outbox JOIN sessions ON sessions.id = outbox.session_id
								WHERE outbox.project_key = ${this.projectId} AND outbox.command_id = ${command.command_id}
								AND outbox.status = 'running' AND outbox.attempt_count = ${command.attempt_count}`;
							if (!claim) {
								yield* requeue;
								pending.delete(command);
								return;
							}
							if (claim.provider !== instanceId) return;
							const settleSession =
								claim.request_sequence === claim.latest_active_sequence;
							this.rememberSessionInstance(sessionId, instanceId);
							const revision = this.historyRevisions.get(sessionId) ?? 0;
							const generation = this.reconnectGenerations.get(instanceId) ?? 0;
							const statuses = yield* readStatuses(instanceId, sessionId).pipe(
								Effect.timeout(BACKFILL_TIMEOUT),
							);
							const terminalStatus =
								statuses !== "stopped" &&
								runTerminalStatus(
									{
										type: "session.status",
										data: { status: statuses?.[sessionId]?.type },
									},
									"opencode",
								);
							if (statuses !== "stopped" && terminalStatus !== "completed")
								return;
							// A result can have finished entirely while the daemon was down.
							const controller = new AbortController();
							const history =
								statuses === "stopped"
									? []
									: yield* this.fetchSessionMessages(
											sessionId,
											instanceId,
											controller.signal,
										).pipe(
											Effect.catch((cause) =>
												cause instanceof OpenCodeApiError &&
												cause.responseStatus === 404
													? Effect.succeed([])
													: Effect.fail(cause),
											),
											Effect.timeout(BACKFILL_TIMEOUT),
											Effect.ensuring(Effect.sync(() => controller.abort())),
										);
							yield* this.sessionGate(sessionId).withPermits(1)(
								Effect.gen({ self: this }, function* () {
									const current = (checkOpenTurns = true) =>
										Effect.gen({ self: this }, function* () {
											if (
												this.stopped ||
												revision !==
													(this.historyRevisions.get(sessionId) ?? 0) ||
												generation !==
													(this.reconnectGenerations.get(instanceId) ?? 0)
											)
												return yield* Effect.interrupt;
											// Admission need not emit SSE. Fence the provider proof on
											// durable writes too, inside each committing transaction.
											const valid = yield* this
												.sql`SELECT 1 FROM provider_command_outbox outbox
										JOIN sessions ON sessions.id = outbox.session_id
										WHERE outbox.project_key = ${this.projectId} AND outbox.command_id = ${command.command_id}
										AND outbox.status = 'running' AND outbox.attempt_count = ${command.attempt_count}
										AND sessions.provider = ${instanceId}
										AND (SELECT MAX(request_sequence) FROM provider_command_outbox WHERE session_id = ${sessionId} AND effect_type = 'send_turn') = ${claim.latest_sequence}
										AND (SELECT MAX(request_sequence) FROM provider_command_outbox WHERE session_id = ${sessionId} AND effect_type = 'send_turn' AND status NOT IN ('completed', 'failed')) = ${claim.latest_active_sequence}
										AND (${settleSession && checkOpenTurns ? 1 : 0} = 0 OR NOT EXISTS (SELECT 1 FROM turns WHERE session_id = ${sessionId}
											AND state IN ('pending', 'running') AND user_message_id IS NOT ${claim.user_message_id}
											AND (${claim.run_id} IS NULL OR run_id IS NOT ${claim.run_id})))`;
											if (!valid.length) return yield* Effect.interrupt;
										});
									yield* current(false);
									const asks = yield* this
										.sql`SELECT 1 FROM pending_approvals WHERE session_id = ${sessionId} AND status = 'pending'`;
									if (asks.length) return;
									// A new busy signal can reopen the previous finished turn
									// before its own echo. Restore only a proven, completed
									// predecessor, never unrelated newer provider history.
									const predecessors = yield* this.sql<{
										user_message_id: string;
									}>`
										SELECT turns.user_message_id FROM turns
										JOIN messages user ON user.id = turns.user_message_id AND user.session_id = turns.session_id
										JOIN provider_command_outbox prior ON prior.command_id = user.input_id AND prior.session_id = turns.session_id
										WHERE turns.session_id = ${sessionId} AND turns.state IN ('pending', 'running')
											AND prior.project_key = ${this.projectId} AND prior.provider_id = ${instanceId}
											AND prior.effect_type = 'send_turn' AND prior.status = 'completed'
											AND prior.request_sequence < ${claim.request_sequence}`;
									const predecessorIds = new Set(
										predecessors
											.filter(({ user_message_id }) =>
												history.some(
													(message) =>
														message.role === "assistant" &&
														message.parentID === user_message_id &&
														isSettled(message) &&
														!message.error,
												),
											)
											.map(({ user_message_id }) => user_message_id),
									);
									// Exact command-to-message ownership excludes unrelated history,
									// including when this send has no echoed or reserved native ID.
									const ownHistory = history.filter(
										(message) =>
											message.id === claim.user_message_id ||
											message.parentID === claim.user_message_id ||
											predecessorIds.has(message.id) ||
											(message.parentID !== undefined &&
												predecessorIds.has(message.parentID)),
									);
									if (ownHistory.length)
										yield* this.applyBackfill(
											sessionId,
											ownHistory,
											instanceId,
											generation,
											revision,
											{
												beforeCommit: current(false),
												completeHistory:
													predecessorIds.size === 0 &&
													ownHistory.length === history.length,
												restoreTurns: true,
											},
										);
									const [untagged] = yield* this.sql<{
										created_at: number;
									}>`SELECT created_at FROM messages
										WHERE session_id = ${sessionId} AND id = ${claim.user_message_id} AND role = 'user'
										AND input_id IS NULL AND rest_digest IS NOT NULL`;
									if (untagged) {
										// The late-echo projector path tags a snapshot without
										// resetting its turn, and removes a recovered steer from the tray.
										yield* this.ingestBatch(
											[
												{
													eventId: `evt_opencode_recovered_input_${sessionId}_${command.command_id}`,
													type: "message.created",
													providerId: "opencode",
													sessionId,
													...(claim.run_id ? { runId: claim.run_id } : {}),
													providerRefs: {},
													rawSource: {
														kind: "conduit.opencode.orphan-recovery",
													},
													createdAt: untagged.created_at,
													data: {
														messageId: claim.user_message_id,
														role: "user",
														sessionId,
														inputId: command.command_id,
														backfilled: true,
													},
												},
											],
											{ beforeCommit: current(false) },
										);
									}
									// New sends reserve their native ID from the durable input ID.
									// Persisted echoes still identify sends from older versions.
									const [turn] = yield* this.sql<{
										state: string;
										run_id: string | null;
									}>`
						SELECT turns.state, turns.run_id FROM turns
						WHERE turns.session_id = ${sessionId} AND turns.user_message_id = ${claim.user_message_id}`;
									const reply = ownHistory
										.filter(
											({ parentID }) => parentID === claim.user_message_id,
										)
										.at(-1);
									// Idle confirms the end; OpenCode's loop finish proves success.
									const completed =
										turn?.run_id != null &&
										turn.run_id === claim.run_id &&
										terminalStatus === "completed" &&
										reply?.finish &&
										!["tool-calls", "unknown"].includes(reply.finish) &&
										!reply.error;
									const runId = claim.run_id ?? undefined;
									const failure = {
										code: "orphaned",
										message:
											"OpenCode stopped before completing the turn. The prompt was not re-sent.",
									};

									if (
										!completed &&
										turn?.state !== "error" &&
										turn?.state !== "interrupted"
									) {
										yield* failTurn(
											sessionId,
											failure.message,
											failure.code,
											runId ? { runId } : { inputId: command.command_id },
											{
												beforeProject: current(),
												settleSession,
											},
										);
									} else
										yield* this.ingestBatch(
											settleSession || (completed && runId)
												? [
														{
															eventId: createEventId(),
															type: "session.status",
															providerId: "opencode",
															sessionId,
															...(runId ? { runId } : {}),
															providerRefs: {},
															rawSource: {
																kind: "conduit.opencode.orphan-recovery",
															},
															createdAt: Date.now(),
															data: { sessionId, status: "idle" },
														},
													]
												: [],
											{
												beforeProject: current(),
											},
										);
									// Publication owns its own CommitAndSignal transaction. A
									// crash here is covered by the inbox startup requeue sweep.
									const terminal = yield* this
										.sql`SELECT 1 FROM provider_command_outbox WHERE project_key = ${this.projectId}
										AND command_id = ${command.command_id} AND attempt_count = ${command.attempt_count} AND status IN ('completed', 'failed')`;
									if (!terminal.length) return;
									yield* requeue;
									pending.delete(command);
								}),
							);
						}).pipe(
							Effect.catchCause((cause) =>
								Failure.isInterruptedOnly(cause)
									? Effect.void
									: Effect.sync(() =>
											this.log.warn("OpenCode send recovery deferred", {
												sessionId: command.session_id,
												error: Failure.renderCause(cause),
											}),
										),
							),
						),
					{ discard: true },
				).pipe(
					// A restart can leave only the publication half of settlement.
					// Keep retrying the existing project-local inbox sweep as well.
					Effect.andThen(
						Effect.gen({ self: this }, function* () {
							if (this.stopped) return;
							const persist = yield* Effect.serviceOption(
								ClaudeEventPersistEffectTag,
							);
							if (persist._tag === "Some") {
								const sessions = yield* this.sql<{ session_id: string }>`
									SELECT DISTINCT pending.session_id FROM pending_inputs pending
									JOIN sessions session ON session.id = pending.session_id
									JOIN provider_command_outbox outbox ON outbox.command_id = pending.input_id
										AND outbox.session_id = pending.session_id
									WHERE session.project_id = ${this.projectId} AND outbox.project_key = ${this.projectId}
										AND pending.state = 'steering' AND outbox.effect_type = 'send_turn' AND outbox.status = 'failed'`;
								for (const { session_id } of sessions)
									yield* requeueFailedSteers(
										this.sql,
										persist.value,
										session_id,
									);
							}
						}).pipe(
							Effect.catchCause((cause) =>
								Effect.sync(() =>
									this.log.warn("Input requeue recovery deferred", {
										error: Failure.renderCause(cause),
									}),
								),
							),
						),
					),
				),
			)
			.pipe(Effect.asVoid);
	}

	onSSEEventEffect(
		event: SSEEvent,
		sessionId: string | undefined,
		providerInstanceId: string,
		context: OpenCodeEventContext = {},
	): Effect.Effect<OpenCodeRuntimeIngressResult> {
		return Effect.gen({ self: this }, function* () {
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
			this.rememberSessionInstance(
				sessionId,
				providerInstanceId,
				context.directory,
			);
			this.historyRevisions.set(
				sessionId,
				(this.historyRevisions.get(sessionId) ?? 0) + 1,
			);
			const result = yield* this.sessionGate(sessionId).withPermits(1)(
				Effect.gen({ self: this }, function* () {
					const ingest = this.ingestSessionEvent(
						event,
						sessionId,
						providerInstanceId,
						context.providerProcessId,
					);
					// Fork copies can arrive before its HTTP response even when a
					// history read already seeded the session. Persist the cut first.
					return yield* this.sessionCreationGate.withPermits(1)(ingest);
				}),
			);
			if (event.type === "session.deleted") this.removeSession(sessionId);
			return result;
		}).pipe(
			Effect.catch((err: unknown) =>
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
		providerProcessId?: string,
	): Effect.Effect<OpenCodeRuntimeIngressResult, unknown> {
		return Effect.gen({ self: this }, function* () {
			if (yield* this.withSql(isSessionDeleted(sessionId))) {
				this.removeSession(sessionId);
				this.stats.eventsSkipped++;
				return { ok: false, reason: "no-session" } as const;
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
			const cachedParentId = this.parentIds.get(sessionId);
			if (
				cachedParentId &&
				(yield* this.withSql(isSessionDeleted(cachedParentId)))
			) {
				yield* this.ingestBatch(
					[
						opencodeSessionCreatedRuntimeEvent(
							sessionId,
							providerInstanceId,
							cachedParentId,
						),
					],
					{ publishToRelay: false },
				);
				this.removeSession(sessionId);
				this.stats.eventsSkipped++;
				return { ok: false, reason: "no-session" } as const;
			}
			const translation = this.translator.forkSession(sessionId);
			// Reconnect clears announcement state, not a native echo's recorded
			// input. A repeated marker must never consume a new summarize bridge.
			const compactionMessageId =
				isPartUpdatedEvent(event) &&
				event.properties.part?.type === "compaction"
					? (event.properties.part.messageID ?? event.properties.messageID)
					: undefined;
			const [recorded] = compactionMessageId
				? yield* this.sql`SELECT 1 FROM messages WHERE session_id = ${sessionId}
					AND id = ${compactionMessageId} AND input_id IS NOT NULL`
				: [];
			const translated = recorded
				? null
				: yield* Effect.try({
						try: () =>
							this.translator.translateInto(event, sessionId, translation),
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
							parentId &&
							((yield* this.hasProjectedSession(parentId)) ||
								(yield* this.withSql(isSessionDeleted(parentId))))
								? parentId
								: undefined;
						yield* this.ingestBatch(
							[
								opencodeSessionCreatedRuntimeEvent(
									sessionId,
									providerInstanceId,
									knownParentId,
								),
							],
							{ publishToRelay: false },
						);
						if (yield* this.hasProjectedSession(sessionId)) {
							this.seenSessions.add(sessionId);
							this.parentIds.delete(sessionId);
						}
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

			const sessionSeeded =
				translated.some(canSeedSession) && !this.seenSessions.has(sessionId);
			const shouldAppendSessionCreation =
				sessionSeeded && !(yield* this.hasProjectedSession(sessionId));
			// Unknown parents cannot satisfy the FK. Deleted parents are retained
			// so ingestion can durably delete their late-discovered children too.
			const parentId = this.parentIds.get(sessionId);
			const knownParentId =
				shouldAppendSessionCreation &&
				parentId !== undefined &&
				((yield* this.hasProjectedSession(parentId)) ||
					(yield* this.withSql(isSessionDeleted(parentId))))
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
				...translated.map((runtimeEvent) =>
					providerProcessId
						? {
								...runtimeEvent,
								providerRefs: {
									...runtimeEvent.providerRefs,
									providerProcessId,
								},
							}
						: runtimeEvent,
				),
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
			const ingestOptions = {
				publishToRelay: false,
				...(translation.droppedRewrite
					? { beforeCommit: this.invalidateHistory(sessionId) }
					: {}),
				afterCommit: Effect.gen({ self: this }, function* () {
					this.translator.commitSession(sessionId, translation);
					if (translation.droppedRewrite) this.syncedSessions.delete(sessionId);
					if (
						!this.seenSessions.has(sessionId) &&
						(yield* this.hasProjectedSession(sessionId))
					) {
						this.seenSessions.add(sessionId);
						this.parentIds.delete(sessionId);
					}
				}),
			};
			const sessionError =
				event.type === "session.error"
					? runtimeEvents.find((event) => event.type === "turn.error")
					: undefined;
			const sessionIdle =
				event.type === "session.status" &&
				runtimeEvents.some(
					(event) =>
						event.type === "session.status" &&
						isRecord(event.data) &&
						event.data["status"] === "idle",
				);
			const written =
				sessionError && isRecord(sessionError.data)
					? yield* settleSessionRuns(
							this.sql,
							sessionId,
							String(sessionError.data["error"] ?? "OpenCode session failed"),
							(events) => this.ingestion.ingestBatch(events, ingestOptions),
							{
								knownEnds: yield* this.ownRunEvents(runtimeEvents),
								errorCode: String(
									sessionError.data["code"] ?? "provider_error",
								),
							},
						)
					: sessionIdle
						? yield* settleSessionRuns(
								this.sql,
								sessionId,
								"OpenCode reported session idle",
								(events) => this.ingestion.ingestBatch(events, ingestOptions),
								{ knownEnds: yield* this.ownRunEvents(runtimeEvents) },
							)
						: yield* this.ingestBatch(runtimeEvents, ingestOptions);
			const promptProperties: Record<string, unknown> = event.properties;
			const providerRequestId =
				typeof promptProperties["requestID"] === "string"
					? promptProperties["requestID"]
					: promptProperties["id"];
			const prompt =
				providerProcessId &&
				typeof providerRequestId === "string" &&
				(event.type.startsWith("permission.") ||
					event.type.startsWith("question."))
					? (yield* this.withSql(
							this.sql<{ id: string; status: string }>`
								SELECT id, status FROM pending_approvals
								WHERE session_id = ${sessionId}
									AND ((provider_process_id = ${providerProcessId}
										AND provider_request_id = ${providerRequestId})
										OR (id = ${providerRequestId} AND provider_process_id IS NULL))
								ORDER BY provider_process_id IS NOT NULL DESC LIMIT 1`,
						))[0]
					: undefined;

			yield* this.refreshSyncedSession(sessionId, event);
			if (
				event.type !== "session.deleted" &&
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
				...(prompt ? { prompt } : {}),
				eventsWritten: written,
				sessionSeeded,
			} satisfies OpenCodeRuntimeIngressResult;
		});
	}

	/** A stopped process confirms that none of its sessions can still execute. */
	onInstanceStopped(
		providerInstanceId: string,
		isCurrent: () => boolean,
	): Effect.Effect<void> {
		return this.withSql(
			Effect.gen({ self: this }, function* () {
				if (this.stopped || !isCurrent()) return;
				const defaultId = MANAGED_OPENCODE_ACCOUNT_ID;
				const instanceIds =
					providerInstanceId === defaultId ||
					providerInstanceId === this.selectedInstanceId
						? [defaultId, this.selectedInstanceId]
						: [providerInstanceId];
				const candidates = yield* this.sql<{ id: string; provider: string }>`
					SELECT id, provider FROM sessions WHERE project_id = ${this.projectId}
					AND provider IN ${this.sql.in(instanceIds)}`;
				for (const { id: sessionId, provider } of candidates) {
					yield* this.sessionGate(sessionId).withPermits(1)(
						Effect.gen({ self: this }, function* () {
							const current = Effect.gen({ self: this }, function* () {
								if (this.stopped || !isCurrent())
									return yield* Effect.interrupt;
								const [binding] = yield* this.sql`SELECT 1 FROM sessions s
									JOIN session_providers sp ON sp.session_id = s.id AND sp.provider = s.provider AND sp.status = 'active'
									WHERE s.id = ${sessionId} AND s.project_id = ${this.projectId} AND s.provider = ${provider}`;
								if (!binding) return yield* Effect.interrupt;
							});
							yield* current;
							yield* settleSessionRuns(
								this.sql,
								sessionId,
								"OpenCode instance stopped",
								(events) =>
									this.ingestion.ingestBatch(events, {
										beforeProject: current,
										beforeCommit: current,
									}),
								{ confirmedStop: true },
							);
						}).pipe(
							Effect.catchCause((cause) =>
								Failure.isInterruptedOnly(cause)
									? Effect.void
									: Effect.logWarning(
											"Stopped OpenCode settlement deferred",
											cause,
										),
							),
						),
					);
				}
			}),
		).pipe(
			Effect.catch((cause) =>
				Effect.sync(() =>
					this.log.warn("Failed to settle stopped OpenCode sessions", {
						providerInstanceId,
						error: formatErrorDetail(cause),
					}),
				),
			),
		);
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
			Effect.gen({ self: this }, function* () {
				const sql = yield* SqlClient.SqlClient;
				for (const [sessionId, instanceId] of this.sessionInstanceIds) {
					if (!instances.has(instanceId)) continue;
					yield* this.sessionGate(sessionId).withPermits(1)(
						Effect.gen({ self: this }, function* () {
							if (this.sessionInstanceIds.get(sessionId) !== instanceId) return;
							const rows = yield* sql<{
								id: string;
							}>`UPDATE sessions SET history_complete = 0
								WHERE id = ${sessionId} AND project_id = ${this.projectId} RETURNING id`;
							if (rows.length > 0)
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
					}>`SELECT provider FROM sessions
						WHERE id = ${sessionId} AND project_id = ${this.projectId}`,
			),
		).pipe(
			Effect.flatMap((rows) => {
				const instanceId = rows[0]?.provider;
				if (!instanceId) return Effect.void;
				this.rememberSessionInstance(sessionId, instanceId);
				return this.startBackfill(sessionId, instanceId);
			}),
			Effect.catch(() => Effect.void),
		);
	}

	private removeSession(sessionId: string): void {
		this.backfillFibers.get(sessionId)?.interruptUnsafe();
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
		this.sessionDirectories.delete(sessionId);
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
					SELECT history_complete FROM sessions
					WHERE id = ${sessionId} AND project_id = ${this.projectId}`,
			),
		).pipe(
			Effect.map((rows) => rows[0]?.history_complete === 1),
			Effect.catch(() => Effect.succeed(false)),
		);
	}

	shutdown(): void {
		this.stopped = true;
		for (const fiber of this.backfillFibers.values()) fiber.interruptUnsafe();
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
		this.sessionDirectories.clear();
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
	resolveSessionPick?: EffectOpenCodeRuntimeIngressOptions["resolveSessionPick"],
	backfillRetryDelayMs?: number,
): Effect.Effect<
	EffectOpenCodeRuntimeIngress,
	ProjectionRunnerError | SqlError,
	| SqlClient.SqlClient
	| ProjectionRunnerEffectTag
	| ProviderRuntimeIngestionTag
	| PersistenceProjectTag
> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const { projectId } = yield* PersistenceProjectTag;
		const creationGate = yield* Effect.serviceOption(
			OpenCodeSessionCreationGateTag,
		);
		const retries = yield* Effect.serviceOption(SessionRetriesTag);
		const config = yield* Effect.serviceOption(ConfigTag);
		const ingress = new EffectOpenCodeRuntimeIngress({
			projectId,
			sql,
			projectionRunner,
			ingestion,
			log,
			...(backfillRetryDelayMs !== undefined ? { backfillRetryDelayMs } : {}),
			...(creationGate._tag === "Some"
				? { sessionCreationGate: creationGate.value }
				: {}),
			...(fetchSessionMessages ? { fetchSessionMessages } : {}),
			...(inputIdForUserEcho ? { inputIdForUserEcho } : {}),
			...(resolveSessionPick ? { resolveSessionPick } : {}),
			...(retries._tag === "Some" ? { retryingOf: retries.value } : {}),
			...(config._tag === "Some" && config.value.openCodeInstanceId
				? { selectedInstanceId: config.value.openCodeInstanceId }
				: {}),
		});
		yield* ingress.recoverEffect();
		// Reconciliation proof is valid only for the process that fetched REST.
		yield* sql`UPDATE sessions SET history_complete = 0 WHERE project_id = ${projectId}`;
		return ingress;
	});
