import { describe, it } from "@effect/vitest";
import { Effect, Layer, Queue } from "effect";
import { assert, expect } from "vitest";
import {
	DaemonEventBusLive,
	publishInstanceAdded,
	publishStatusChanged,
	publishVersionUpdate,
	subscribeToDaemonEvents,
} from "../../../src/lib/effect/daemon-pubsub.js";

describe("DaemonEventBus", () => {
	it.scoped("publishes and receives StatusChanged events", () =>
		Effect.gen(function* () {
			const sub = yield* subscribeToDaemonEvents;
			yield* publishStatusChanged({ s1: "busy", s2: "idle" });
			const event = yield* Queue.take(sub);
			expect(event._tag).toBe("StatusChanged");
		}).pipe(Effect.provide(Layer.fresh(DaemonEventBusLive))),
	);

	it.scoped("multiple subscribers each receive events", () =>
		Effect.gen(function* () {
			const sub1 = yield* subscribeToDaemonEvents;
			const sub2 = yield* subscribeToDaemonEvents;
			yield* publishVersionUpdate("1.0.0", "1.1.0");
			const e1 = yield* Queue.take(sub1);
			const e2 = yield* Queue.take(sub2);
			expect(e1._tag).toBe("VersionUpdate");
			expect(e2._tag).toBe("VersionUpdate");
		}).pipe(Effect.provide(Layer.fresh(DaemonEventBusLive))),
	);

	it.scoped("InstanceAdded carries instanceId", () =>
		Effect.gen(function* () {
			const sub = yield* subscribeToDaemonEvents;
			yield* publishInstanceAdded("inst-42");
			const result = yield* Queue.take(sub);
			expect(result._tag).toBe("InstanceAdded");
			assert(result._tag === "InstanceAdded");
			expect(result.instanceId).toBe("inst-42");
		}).pipe(Effect.provide(Layer.fresh(DaemonEventBusLive))),
	);
});
