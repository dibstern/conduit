// ─── Daemon PubSub Event Bus ────────────────────────────────────────────────
// Sliding PubSub for broadcasting daemon-level events to subscribers.
// Oldest events are dropped if a consumer falls behind (capacity 256).

import { Context, Data, Layer, PubSub } from "effect";

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
