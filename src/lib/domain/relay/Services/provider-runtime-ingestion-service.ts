import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer, Ref } from "effect";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import type {
	CanonicalEvent,
	StoredEvent,
} from "../../../persistence/events.js";
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
			const eventStore = yield* EventStoreEffectTag;
			const projectionRunner = yield* ProjectionRunnerEffectTag;
			const sql = yield* SqlClient.SqlClient;
			const mapperStateRef = yield* Ref.make(
				emptyProviderRuntimeDomainMapperState,
			);
			const ingestSemaphore = yield* Effect.makeSemaphore(1);

			const ingestBatch = (
				events: readonly ProviderRuntimeEvent[],
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

						const storedEvents = yield* eventStore.appendBatch(domainEvents);

						yield* Ref.set(mapperStateRef, nextState);

						if (storedEvents.length === 1 && storedEvents[0]) {
							yield* projectionRunner
								.projectEvent(storedEvents[0])
								.pipe(Effect.provideService(SqlClient.SqlClient, sql));
						} else if (storedEvents.length > 1) {
							yield* projectionRunner
								.projectBatch(storedEvents)
								.pipe(Effect.provideService(SqlClient.SqlClient, sql));
						}

						if (options.relayPublisher) {
							yield* publishRelayMessages(storedEvents, options.relayPublisher);
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
	events: readonly StoredEvent[],
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
