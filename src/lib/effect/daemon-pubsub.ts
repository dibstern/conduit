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
	InstanceError: { readonly instanceId: string; readonly error: string };
	// Session lifecycle events (used by relay wiring Layers)
	SessionCreated: { readonly sessionId: string };
	SessionDeleted: { readonly sessionId: string };
	RelayBroadcast: { readonly message: unknown };
	ConfigChanged: {};
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

const publish = (event: DaemonEvent) =>
	DaemonEventBusTag.pipe(Effect.flatMap((bus) => PubSub.publish(bus, event)));

export const publishStatusChanged = (statuses: Record<string, string>) =>
	publish(DaemonEvent.StatusChanged({ statuses }));

export const publishVersionUpdate = (current: string, latest: string) =>
	publish(DaemonEvent.VersionUpdate({ current, latest }));

export const publishInstanceAdded = (instanceId: string) =>
	publish(DaemonEvent.InstanceAdded({ instanceId }));

export const publishInstanceRemoved = (instanceId: string) =>
	publish(DaemonEvent.InstanceRemoved({ instanceId }));

export const publishInstanceStatusChanged = (instanceId: string) =>
	publish(DaemonEvent.InstanceStatusChanged({ instanceId }));

export const publishDiskSpaceLow = (usage: number) =>
	publish(DaemonEvent.DiskSpaceLow({ usage }));

export const publishDiskSpaceOk = (usage: number) =>
	publish(DaemonEvent.DiskSpaceOk({ usage }));

export const publishInstanceError = (instanceId: string, error: string) =>
	publish(DaemonEvent.InstanceError({ instanceId, error }));

export const publishSessionCreated = (sessionId: string) =>
	publish(DaemonEvent.SessionCreated({ sessionId }));

export const publishSessionDeleted = (sessionId: string) =>
	publish(DaemonEvent.SessionDeleted({ sessionId }));

export const publishRelayBroadcast = (message: unknown) =>
	publish(DaemonEvent.RelayBroadcast({ message }));

export const publishConfigChanged = publish(DaemonEvent.ConfigChanged());

// ─── Subscriber ─────────────────────────────────────────────────────────────

export const subscribeToDaemonEvents: Effect.Effect<
	Queue.Dequeue<DaemonEvent>,
	never,
	DaemonEventBusTag | Scope.Scope
> = Effect.gen(function* () {
	const bus = yield* DaemonEventBusTag;
	return yield* PubSub.subscribe(bus);
});
