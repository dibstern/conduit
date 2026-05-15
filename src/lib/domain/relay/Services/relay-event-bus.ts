import { Context, Effect, Layer, PubSub, type Queue, type Scope } from "effect";
import type { RelayEvent } from "./relay-domain-model.js";

export const RELAY_EVENT_BUS_CAPACITY = 256;

export class RelayEventBusTag extends Context.Tag("RelayEventBus")<
	RelayEventBusTag,
	PubSub.PubSub<RelayEvent>
>() {}

export const makeRelayEventBusLive = (
	options: { readonly capacity?: number } = {},
) =>
	Layer.effect(
		RelayEventBusTag,
		PubSub.sliding<RelayEvent>({
			capacity: options.capacity ?? RELAY_EVENT_BUS_CAPACITY,
		}),
	);

// Sliding buffer policy: slow in-process reactors see recent relay signals.
// Durable relay events remain the replay source; this bus is not the backlog.
export const RelayEventBusLive = makeRelayEventBusLive();

export const publishRelayEvent = (event: RelayEvent) =>
	RelayEventBusTag.pipe(Effect.flatMap((bus) => PubSub.publish(bus, event)));

export const publishRelayEvents = (events: readonly RelayEvent[]) =>
	Effect.forEach(events, publishRelayEvent, { discard: true });

export const subscribeToRelayEvents: Effect.Effect<
	Queue.Dequeue<RelayEvent>,
	never,
	RelayEventBusTag | Scope.Scope
> = Effect.gen(function* () {
	const bus = yield* RelayEventBusTag;
	return yield* PubSub.subscribe(bus);
});
