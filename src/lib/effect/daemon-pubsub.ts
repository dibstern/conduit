// ─── Daemon PubSub Event Bus ────────────────────────────────────────────────
// Sliding PubSub for broadcasting daemon-level events to subscribers.
// Oldest events are dropped if a consumer falls behind (capacity 256).

import {
	Context,
	Data,
	Effect,
	Layer,
	PubSub,
	type Queue,
	type Scope,
} from "effect";

export type DaemonEvent = Data.TaggedEnum<{
	StatusChanged: { readonly statuses: Record<string, string> };
	VersionUpdate: { readonly current: string; readonly latest: string };
	InstanceAdded: { readonly instanceId: string };
	InstanceRemoved: { readonly instanceId: string };
	InstanceStatusChanged: { readonly instanceId: string };
	DiskSpaceLow: { readonly usage: number };
	DiskSpaceOk: { readonly usage: number };
}>;

export const DaemonEvent = Data.taggedEnum<DaemonEvent>();

export class DaemonEventBusTag extends Context.Tag("DaemonEventBus")<
	DaemonEventBusTag,
	PubSub.PubSub<DaemonEvent>
>() {}

// sliding(256) — oldest events dropped if consumer falls behind.
export const DaemonEventBusLive = Layer.effect(
	DaemonEventBusTag,
	PubSub.sliding<DaemonEvent>({ capacity: 256 }),
);

// ─── Publisher Helpers ──────────────────────────────────────────────────────

export const publishStatusChanged = (statuses: Record<string, string>) =>
	Effect.gen(function* () {
		const bus = yield* DaemonEventBusTag;
		yield* PubSub.publish(bus, DaemonEvent.StatusChanged({ statuses }));
	});

export const publishVersionUpdate = (current: string, latest: string) =>
	Effect.gen(function* () {
		const bus = yield* DaemonEventBusTag;
		yield* PubSub.publish(bus, DaemonEvent.VersionUpdate({ current, latest }));
	});

export const publishInstanceAdded = (instanceId: string) =>
	Effect.gen(function* () {
		const bus = yield* DaemonEventBusTag;
		yield* PubSub.publish(bus, DaemonEvent.InstanceAdded({ instanceId }));
	});

export const publishInstanceRemoved = (instanceId: string) =>
	Effect.gen(function* () {
		const bus = yield* DaemonEventBusTag;
		yield* PubSub.publish(bus, DaemonEvent.InstanceRemoved({ instanceId }));
	});

export const publishInstanceStatusChanged = (instanceId: string) =>
	Effect.gen(function* () {
		const bus = yield* DaemonEventBusTag;
		yield* PubSub.publish(
			bus,
			DaemonEvent.InstanceStatusChanged({ instanceId }),
		);
	});

export const publishDiskSpaceLow = (usage: number) =>
	Effect.gen(function* () {
		const bus = yield* DaemonEventBusTag;
		yield* PubSub.publish(bus, DaemonEvent.DiskSpaceLow({ usage }));
	});

export const publishDiskSpaceOk = (usage: number) =>
	Effect.gen(function* () {
		const bus = yield* DaemonEventBusTag;
		yield* PubSub.publish(bus, DaemonEvent.DiskSpaceOk({ usage }));
	});

// ─── Subscriber ─────────────────────────────────────────────────────────────

export const subscribeToDaemonEvents: Effect.Effect<
	Queue.Dequeue<DaemonEvent>,
	never,
	DaemonEventBusTag | Scope.Scope
> = Effect.gen(function* () {
	const bus = yield* DaemonEventBusTag;
	return yield* PubSub.subscribe(bus);
});
