import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer, Ref } from "effect";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import type { CanonicalEvent } from "../../../persistence/events.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "../../../provider/provider-runtime-event-to-domain.js";

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

export const ProviderRuntimeIngestionLive: Layer.Layer<
	ProviderRuntimeIngestionTag,
	never,
	EventStoreEffectTag | ProjectionRunnerEffectTag | SqlClient.SqlClient
> = Layer.effect(
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
						domainEvents.push(...result.events);
						nextState = result.state;
					}

					const storedEvents = yield* sql.withTransaction(
						Effect.gen(function* () {
							for (const event of events) {
								if (event.type !== "session.created") continue;
								const data = event.data as Record<string, unknown>;
								const sessionId =
									typeof data["sessionId"] === "string"
										? data["sessionId"]
										: event.sessionId;
								const provider =
									typeof data["provider"] === "string"
										? data["provider"]
										: event.providerId;
								const providerSessionId =
									typeof event.providerRefs.providerSessionId === "string"
										? event.providerRefs.providerSessionId
										: null;
								const title =
									typeof data["title"] === "string"
										? data["title"]
										: "Untitled";
								const timestamp =
									typeof event.createdAt === "number"
										? event.createdAt
										: Date.parse(event.createdAt);
								const now = Number.isFinite(timestamp) ? timestamp : Date.now();

								yield* sql`
								INSERT OR IGNORE INTO sessions
								(id, provider, provider_sid, title, status, parent_id, created_at, updated_at)
								VALUES (${sessionId}, ${provider}, ${providerSessionId}, ${title}, 'idle', null, ${now}, ${now})`;
							}

							return yield* eventStore.appendBatch(domainEvents);
						}),
					);

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
