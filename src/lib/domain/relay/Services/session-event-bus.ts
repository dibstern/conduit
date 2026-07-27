import { Context, Effect, Layer, PubSub, type Scope, Stream } from "effect";
import type { StoredEvent } from "../../../persistence/events.js";

export const SESSION_EVENT_BUS_CAPACITY = 256;

export interface SessionEventFilter {
	readonly sessionId?: string;
}

/**
 * Transport-agnostic change signal for committed session events.
 *
 * Deep interface: callers publish committed {@link StoredEvent}s post-commit and
 * subscribe to a session-filtered stream. Fan-out, per-session filtering, and
 * the sliding-buffer capacity policy are hidden — unlike RelayEventBus, which
 * exposes its raw PubSub. A slow subscriber drops the oldest signals rather than
 * blocking the publisher; the durable, sequence-addressed event store is the
 * replay/resume source, so a subscriber that falls behind recovers missing
 * events by sequence gap + store replay (see ReadModelSubscription). This bus is
 * a live change-signal, never the backlog.
 */
export interface SessionEventBus {
	readonly publish: (events: readonly StoredEvent[]) => Effect.Effect<void>;
	/**
	 * Acquire a scoped subscription, then stream its events. Returning
	 * `Effect<Stream>` lets a consumer acquire the subscription *before* reading a
	 * snapshot, so live events are buffered across the snapshot query with no gap.
	 * The subscription is released when the enclosing Scope closes.
	 */
	readonly subscribe: (
		filter?: SessionEventFilter,
	) => Effect.Effect<Stream.Stream<StoredEvent>, never, Scope.Scope>;
}

export class SessionEventBusTag extends Context.Tag("SessionEventBus")<
	SessionEventBusTag,
	SessionEventBus
>() {}

export const makeSessionEventBusLive = (
	options: { readonly capacity?: number } = {},
): Layer.Layer<SessionEventBusTag> =>
	Layer.effect(
		SessionEventBusTag,
		Effect.gen(function* () {
			const pubsub = yield* PubSub.sliding<StoredEvent>({
				capacity: options.capacity ?? SESSION_EVENT_BUS_CAPACITY,
			});
			return {
				publish: (events) =>
					events.length === 0
						? Effect.void
						: Effect.asVoid(PubSub.publishAll(pubsub, events)),
				subscribe: (filter) =>
					Effect.map(PubSub.subscribe(pubsub), (dequeue) => {
						const stream = Stream.fromQueue(dequeue);
						return filter?.sessionId === undefined
							? stream
							: Stream.filter(
									stream,
									(event) => event.sessionId === filter.sessionId,
								);
					}),
			} satisfies SessionEventBus;
		}),
	);

// Sliding buffer: a slow subscriber drops oldest signals, never blocks the
// publisher. Durable events remain the replay source; this bus is not the
// backlog.
export const SessionEventBusLive = makeSessionEventBusLive();
