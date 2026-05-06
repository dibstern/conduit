import { describe, expect, it } from "@effect/vitest";
import {
	Context,
	Duration,
	Effect,
	Layer,
	PubSub,
	Ref,
	TestClock,
} from "effect";
import {
	ConfigPersistenceLive,
	ConfigWriterTag,
} from "../../../src/lib/effect/config-persistence-layer.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "../../../src/lib/effect/daemon-config-ref.js";
import {
	DaemonEvent,
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../../../src/lib/effect/daemon-pubsub.js";

describe("ConfigPersistenceLive", () => {
	const defaults: DaemonRuntimeConfig = {
		port: 2633,
		host: "127.0.0.1",
		pinHash: null,
		tlsEnabled: false,
		keepAwake: false,
		keepAwakeCommand: undefined,
		keepAwakeArgs: undefined,
		shuttingDown: false,
		dismissedPaths: new Set(),
		startTime: Date.now(),
		hostExplicit: false,
		persistedSessionCounts: new Map(),
	};

	const makeTestLayer = () => {
		const writes: DaemonRuntimeConfig[] = [];
		const writerLayer = Layer.succeed(ConfigWriterTag, {
			write: (config: DaemonRuntimeConfig) =>
				Effect.sync(() => {
					writes.push(config);
				}),
		});
		const deps = Layer.mergeAll(
			DaemonConfigRefLive(defaults),
			DaemonEventBusLive,
			writerLayer,
		);
		// Merge deps into output so Context.get can find bus/configRef after build
		const layer = Layer.merge(
			ConfigPersistenceLive.pipe(Layer.provide(deps)),
			deps,
		);
		return { layer, writes };
	};

	it.scoped("writes config to disk on ConfigChanged event", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const bus = Context.get(ctx, DaemonEventBusTag);
			yield* PubSub.publish(bus, DaemonEvent.ConfigChanged());
			yield* TestClock.adjust(Duration.millis(600));
			expect(writes.length).toBeGreaterThanOrEqual(1);
		}),
	);

	it.scoped(
		"coalesces multiple ConfigChanged events within debounce window",
		() =>
			Effect.gen(function* () {
				const { layer, writes } = makeTestLayer();
				const ctx = yield* Layer.build(Layer.fresh(layer));
				const bus = Context.get(ctx, DaemonEventBusTag);
				// Publish 5 events rapidly
				for (let i = 0; i < 5; i++) {
					yield* PubSub.publish(bus, DaemonEvent.ConfigChanged());
				}
				yield* TestClock.adjust(Duration.millis(600));
				expect(writes.length).toBe(1);
			}),
	);

	it.scoped("ignores non-ConfigChanged events", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const bus = Context.get(ctx, DaemonEventBusTag);
			yield* PubSub.publish(
				bus,
				DaemonEvent.StatusChanged({ statuses: { a: "ok" } }),
			);
			yield* PubSub.publish(
				bus,
				DaemonEvent.InstanceAdded({ instanceId: "i1" }),
			);
			yield* TestClock.adjust(Duration.millis(600));
			expect(writes.length).toBe(0);
		}),
	);

	it.scoped("writes reflect current config state at time of flush", () =>
		Effect.gen(function* () {
			const { layer, writes } = makeTestLayer();
			const ctx = yield* Layer.build(Layer.fresh(layer));
			const bus = Context.get(ctx, DaemonEventBusTag);
			const configRef = Context.get(ctx, DaemonConfigRefTag);
			yield* Ref.update(configRef, (c) => ({ ...c, port: 9999 }));
			yield* PubSub.publish(bus, DaemonEvent.ConfigChanged());
			yield* TestClock.adjust(Duration.millis(600));
			expect(writes.length).toBe(1);
			expect(writes[0]!.port).toBe(9999);
		}),
	);
});
