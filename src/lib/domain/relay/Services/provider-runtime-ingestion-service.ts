import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer, Ref } from "effect";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import type { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import type { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import type { CanonicalEvent } from "../../../persistence/events.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "../../../provider/provider-runtime-event-to-domain.js";
import { translateDomainEventToRelay } from "../../../relay/domain-event-to-relay.js";
import { tagWithSessionId } from "../../../shared-types.js";
import type { RelayMessage } from "../../../types.js";

export interface ProviderRuntimeIngestion {
	readonly ingest: (
		event: ProviderRuntimeEvent,
	) => Effect.Effect<number, unknown>;
	readonly ingestBatch: (
		events: readonly ProviderRuntimeEvent[],
		options?: {
			readonly publishToBus?: boolean;
			readonly publishToRelay?: boolean;
			/** Run at the durable boundary: inside the same uninterruptible region
			 *  as append+project, after COMMIT returns and before anything is
			 *  published. This is where a caller records state that only makes
			 *  sense because the batch is durable — a publication defect after it
			 *  must not be able to undo it. */
			readonly afterCommit?: Effect.Effect<void>;
		},
	) => Effect.Effect<number, unknown>;
	readonly drain: () => Effect.Effect<void, unknown>;
}

export class ProviderRuntimeIngestionTag extends Context.Tag(
	"ProviderRuntimeIngestion",
)<ProviderRuntimeIngestionTag, ProviderRuntimeIngestion>() {}

export interface ProviderRuntimeRelayPublisher {
	readonly publish: (message: RelayMessage) => Effect.Effect<void, unknown>;
}

export interface ProviderRuntimeIngestionLiveOptions {
	readonly relayPublisher?: ProviderRuntimeRelayPublisher;
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
			const sql = yield* SqlClient.SqlClient;
			const mapperStateRef = yield* Ref.make(
				emptyProviderRuntimeDomainMapperState,
			);
			const ingestSemaphore = yield* Effect.makeSemaphore(1);

			const ingestBatch = (
				events: readonly ProviderRuntimeEvent[],
				ingestOptions: {
					readonly publishToBus?: boolean;
					readonly publishToRelay?: boolean;
					readonly afterCommit?: Effect.Effect<void>;
				} = {},
			): Effect.Effect<number, unknown> =>
				ingestSemaphore.withPermits(1)(
					Effect.gen(function* () {
						const currentState = yield* Ref.get(mapperStateRef);
						let nextState = currentState;
						const domainEvents: CanonicalEvent[] = [];

						for (const event of events) {
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

						// Compaction notices are UI-only EXCEPT the terminal "completed"
						// boundary, which persists as a synthetic marker so the "Context
						// compacted" divider survives a page reload. All states still
						// publish to the wire below (publishRelayMessages(domainEvents)).
						const persistentEvents = domainEvents.filter(
							(event) =>
								event.type !== "session.compaction" ||
								event.data.state === "completed",
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
						for (const [sessionId, provider] of needsSessionRow) {
							const seededAt = Date.now();
							yield* sql`
									INSERT OR IGNORE INTO sessions
									(id, provider, title, status, created_at, updated_at)
									VALUES (${sessionId}, ${provider}, 'Untitled', 'idle', ${seededAt}, ${seededAt})`;
						}

						yield* commitAndSignal(persistentEvents, {
							publish: ingestOptions.publishToBus ?? true,
							afterCommit: Effect.zipRight(
								Ref.set(mapperStateRef, nextState),
								ingestOptions.afterCommit ?? Effect.void,
							),
						});

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
): Effect.Effect<void, unknown> {
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
