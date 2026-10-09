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
import type { GlobalProjectSetting } from "../../../contracts/ws-rpc.js";

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
	ConfigChanged: Record<never, never>;
	// The daemon's instance or project list changed (conduit-test-ni8.14).
	InstancesChanged: Record<never, never>;
	ProjectsChanged: Record<never, never>;
	GlobalSettingChanged: {
		readonly originSlug: string;
		readonly tag: GlobalProjectSetting["_tag"];
	};
	// SubscribeServerStatus inputs (conduit-test-ni8.16.2): a new build became
	// (un)available, or the cross-project session lists went stale.
	RestartAvailabilityChanged: Record<never, never>;
	DaemonSessionsChanged: Record<never, never>;
}>;

export const DaemonEvent = Data.taggedEnum<DaemonEvent>();

const DAEMON_EVENT_BUFFER_CAPACITY = 256;

export class DaemonEventBusTag extends Context.Tag("DaemonEventBus")<
	DaemonEventBusTag,
	PubSub.PubSub<DaemonEvent>
>() {}

// sliding(256) — oldest events dropped if consumer falls behind.
export const DaemonEventBusLive = Layer.effect(
	DaemonEventBusTag,
	PubSub.sliding<DaemonEvent>({ capacity: DAEMON_EVENT_BUFFER_CAPACITY }),
);

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

export const publishConfigChanged = publish(DaemonEvent.ConfigChanged());

export const subscribeToDaemonEvents: Effect.Effect<
	Queue.Dequeue<DaemonEvent>,
	never,
	DaemonEventBusTag | Scope.Scope
> = Effect.gen(function* () {
	const bus = yield* DaemonEventBusTag;
	return yield* PubSub.subscribe(bus);
});
