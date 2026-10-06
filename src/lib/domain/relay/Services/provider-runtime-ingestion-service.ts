import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Deferred, Effect, FiberRef, Layer, Ref } from "effect";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	type EventStoreError,
} from "../../../persistence/effect/event-store-effect.js";
import type {
	ProjectionRunnerEffectTag,
	ProjectionRunnerError,
} from "../../../persistence/effect/projection-runner-effect.js";
import type { CanonicalEvent } from "../../../persistence/events.js";
import {
	commitClaudeRunnerOutput,
	createClaudeRunnerPermissionReplies,
	currentClaudeRunnerOutput,
	currentClaudeRunnerPermissionReply,
	ownsClaudeRunnerAttachment,
} from "../../../provider/claude/claude-runner-receipts.js";
import {
	emptyProviderRuntimeDomainMapperState,
	partKey,
	restoreRuntimeToolStart,
	translateProviderRuntimeEventToDomain,
} from "../../../provider/provider-runtime-event-to-domain.js";
import { translateDomainEventToRelay } from "../../../relay/domain-event-to-relay.js";
import type { makeSessionCompactions } from "../../../session/session-compactions.js";
import { tagWithSessionId } from "../../../shared-types.js";
import type { RelayMessage } from "../../../types.js";
import { announceBackgroundWork } from "./session-attention.js";

export type ProviderRuntimeIngestionError =
	| EventStoreError
	| ProjectionRunnerError
	| SqlError;

export interface ProviderRuntimeIngestion {
	readonly ingest: (
		event: ProviderRuntimeEvent,
	) => Effect.Effect<number, ProviderRuntimeIngestionError>;
	readonly ingestBatch: (
		events: readonly ProviderRuntimeEvent[],
		options?: {
			readonly publishToBus?: boolean;
			readonly publishToRelay?: boolean;
			readonly beforeCommit?: Effect.Effect<void, SqlError>;
			readonly afterCommit?: Effect.Effect<void>;
		},
	) => Effect.Effect<number, ProviderRuntimeIngestionError>;
	readonly drain: () => Effect.Effect<void>;
}

export class ProviderRuntimeIngestionTag extends Context.Tag(
	"ProviderRuntimeIngestion",
)<ProviderRuntimeIngestionTag, ProviderRuntimeIngestion>() {}

export interface ProviderRuntimeRelayPublisher {
	readonly publish: (message: RelayMessage) => Effect.Effect<void>;
}

export interface ProviderRuntimeIngestionLiveOptions {
	readonly relayPublisher?: ProviderRuntimeRelayPublisher;
	readonly compactions?: Pick<
		ReturnType<typeof makeSessionCompactions>,
		"observe"
	>;
}

export const makeProviderRuntimeIngestionLive = (
	options: ProviderRuntimeIngestionLiveOptions = {},
): Layer.Layer<
	ProviderRuntimeIngestionTag,
	never,
	EventStoreEffectTag | ProjectionRunnerEffectTag | SqlClient.SqlClient
> =>
	Layer.effect(
		ProviderRuntimeIngestionTag,
		Effect.gen(function* () {
			const commitAndSignal = yield* makeCommitAndSignal;
			const eventStore = yield* EventStoreEffectTag;
			const sql = yield* SqlClient.SqlClient;
			const services = yield* Effect.context<
				EventStoreEffectTag | ProjectionRunnerEffectTag | SqlClient.SqlClient
			>();
			const mapperStateRef = yield* Ref.make(
				emptyProviderRuntimeDomainMapperState,
			);
			const ingestSemaphore = yield* Effect.makeSemaphore(1);

			const ingestBatch = (
				events: readonly ProviderRuntimeEvent[],
				ingestOptions: {
					readonly publishToBus?: boolean;
					readonly publishToRelay?: boolean;
					readonly beforeCommit?: Effect.Effect<void, SqlError>;
					readonly afterCommit?: Effect.Effect<void>;
				} = {},
			): Effect.Effect<number, ProviderRuntimeIngestionError> =>
				ingestSemaphore.withPermits(1)(
					Effect.gen(function* () {
						const context = yield* FiberRef.get(currentClaudeRunnerOutput);
						const permissionReply = yield* FiberRef.get(
							currentClaudeRunnerPermissionReply,
						);
						const receipt = context && !context.consumed ? context : undefined;
						const currentState = yield* Ref.get(mapperStateRef);
						let nextState = currentState;
						const domainEvents: CanonicalEvent[] = [];

						for (const event of events) {
							if (context && event.type === "tool.completed") {
								const data = event.data as { partId?: string };
								const partId =
									data.partId ?? event.providerRefs.providerToolUseId;
								if (
									partId &&
									!nextState.startedToolPartIds.has(partKey(event, partId))
								) {
									const started = yield* sql<{
										message_id: string;
									}>`SELECT p.message_id FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE p.id = ${partId} AND m.session_id = ${event.sessionId} AND p.type = 'tool' LIMIT 1`;
									if (started[0])
										nextState = restoreRuntimeToolStart(
											event,
											nextState,
											partId,
											started[0].message_id,
										);
								}
							}
							const result = translateProviderRuntimeEventToDomain(
								event,
								nextState,
							);
							// The mapper synthesizes a tool.started for an orphan
							// tool.completed so the UI can render something — but an
							// orphan means an upstream translator broke the tool
							// lifecycle (2026-07-15: a phantom "Unknown" tool card).
							// Surface it loudly instead of laundering it silently.
							const synthesized =
								event.type === "tool.completed" &&
								result.events.some((domain) => domain.type === "tool.started");
							if (synthesized) {
								yield* Effect.logWarning(
									"ingress synthesized tool.started for orphan tool.completed — upstream translator emitted completed without started",
								).pipe(
									Effect.annotateLogs({
										providerId: event.providerId,
										sessionId: event.sessionId,
										eventId: event.eventId,
										data: JSON.stringify(event.data),
									}),
								);
							}
							domainEvents.push(...result.events);
							nextState = result.state;
						}

						// A compaction's "started" notice is transient status (C1) that
						// rides the shell row (see `compactions` below). Its outcome,
						// completed or failed, persists so the divider or the failure
						// notice survives a reload.
						const persistentEvents = domainEvents.filter(
							(event) =>
								event.type !== "session.compaction" ||
								event.data.state !== "started",
						);

						// Projectors write rows that reference sessions(id), and a
						// provider can stream events for a session Conduit never created
						// — Claude subagents arrive mid-turn under their own id. The FK
						// then rejects the projection, which used to be swallowed, so
						// subagent messages rendered live and were gone after a reload.
						// ClaudeEventPersistEffect.persistEvent already guards its own
						// path with ensureSession; this is the same guard on this one.
						// session.created is left to the session projector, which owns
						// the row and upserts it.
						const createdHere = new Set(
							persistentEvents
								.filter((event) => event.type === "session.created")
								.map((event) => event.sessionId),
						);
						const needsSessionRow = new Map<string, string>();
						for (const event of persistentEvents) {
							if (createdHere.has(event.sessionId)) continue;
							if (!needsSessionRow.has(event.sessionId)) {
								needsSessionRow.set(event.sessionId, event.provider);
							}
						}
						const ensureSessions = Effect.gen(function* () {
							for (const [sessionId, provider] of needsSessionRow) {
								const seededAt = Date.now();
								yield* sql`
									INSERT OR IGNORE INTO sessions
									(id, provider, title, status, created_at, updated_at)
									VALUES (${sessionId}, ${provider}, 'Untitled', 'idle', ${seededAt}, ${seededAt})`;
							}
						});
						let appended = true;
						const beforeCommit = Effect.gen(function* () {
							yield* ingestOptions.beforeCommit ?? Effect.void;
							if (permissionReply) {
								yield* createClaudeRunnerPermissionReplies(sql);
								yield* sql`INSERT OR REPLACE INTO claude_runner_permission_replies (session_id, request_id, response_json) VALUES (${permissionReply.sessionId}, ${permissionReply.requestId}, ${JSON.stringify(permissionReply.response)})`;
							}
						});
						const afterCommit = Effect.gen(function* () {
							if (appended) {
								yield* Ref.set(mapperStateRef, nextState);
								yield* ingestOptions.afterCommit ?? Effect.void;
							}
							if (receipt) {
								receipt.consumed = true;
								yield* Deferred.succeed(receipt.committed, undefined);
								if (appended) receipt.onCommitted?.();
							}
						});
						const commitOptions = {
							publish: ingestOptions.publishToBus ?? true,
							afterCommit,
						};
						if (context && (receipt || context.attachmentId)) {
							yield* commitAndSignal.write(
								(project) =>
									Effect.gen(function* () {
										// Claim inside the append transaction, before event IDs or
										// projections are written. Replayed and fenced frames are no-ops.
										appended = receipt
											? yield* commitClaudeRunnerOutput(sql, receipt)
											: yield* ownsClaudeRunnerAttachment(sql, context);
										if (!appended) return;
										yield* ensureSessions;
										yield* project(
											yield* eventStore.appendBatch(persistentEvents),
										);
										yield* beforeCommit;
									}),
								commitOptions,
							);
						} else {
							yield* ensureSessions;
							yield* commitAndSignal(persistentEvents, {
								...commitOptions,
								beforeCommit,
							});
						}
						if (!appended) return 0;

						// A compaction in progress lives in memory, not the log (C1).
						// Stamp its row so the shell re-reads it.
						yield* Effect.forEach(
							options.compactions?.observe(domainEvents) ?? [],
							announceBackgroundWork,
							{ discard: true },
						).pipe(
							Effect.provide(services),
							Effect.catchAllCause((cause) =>
								Effect.logWarning("failed to announce a compaction", cause),
							),
						);

						if (
							options.relayPublisher &&
							ingestOptions.publishToRelay !== false
						) {
							yield* publishRelayMessages(domainEvents, options.relayPublisher);
						}

						return domainEvents.length;
					}),
				);

			return {
				ingest: (event) => ingestBatch([event]),
				ingestBatch,
				drain: () => Effect.void,
			} satisfies ProviderRuntimeIngestion;
		}),
	);

export const ProviderRuntimeIngestionLive = makeProviderRuntimeIngestionLive();

function publishRelayMessages(
	events: readonly CanonicalEvent[],
	publisher: ProviderRuntimeRelayPublisher,
): Effect.Effect<void> {
	return Effect.forEach(
		events,
		(event) => {
			const translated = translateDomainEventToRelay(event);
			if (translated.kind === "silent") return Effect.void;
			return Effect.forEach(
				translated.messages,
				(message) =>
					publisher.publish(tagWithSessionId(message, event.sessionId)),
				{ discard: true },
			);
		},
		{ discard: true },
	);
}
