import { describe, it } from "@effect/vitest";
import { Effect, Layer, Queue } from "effect";
import { expect } from "vitest";
import {
	DaemonEventBusLive,
	subscribeToDaemonEvents,
} from "../../../src/lib/effect/daemon-pubsub.js";
import {
	type AddInstanceInput,
	addInstance,
	getExternalUrl,
	getInstance,
	getInstanceUrl,
	makeInstanceManagerStateLive,
	persistConfig,
	startInstance,
	stopInstance,
	updateInstance,
} from "../../../src/lib/effect/instance-manager-service.js";

// Shared test layer: InstanceManagerState + PollerFibers + DaemonEventBus
const testLayer = makeInstanceManagerStateLive().pipe(
	Layer.provideMerge(DaemonEventBusLive),
);

const sampleInput: AddInstanceInput = {
	id: "inst-1",
	name: "Test Instance",
	port: 3001,
	managed: true,
};

describe("InstanceManager — missing methods", () => {
	describe("addInstance return type", () => {
		it.scoped("returns the created OpenCodeInstance", () =>
			Effect.gen(function* () {
				const result = yield* addInstance(sampleInput);
				expect(result.id).toBe("inst-1");
				expect(result.name).toBe("Test Instance");
				expect(result.port).toBe(3001);
				expect(result.managed).toBe(true);
				expect(result.status).toBe("starting");
				expect(result.restartCount).toBe(0);
				expect(typeof result.createdAt).toBe("number");
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
		);
	});

	describe("startInstance", () => {
		it.scoped("sets status to 'starting' and publishes event", () =>
			Effect.gen(function* () {
				// First add an instance, then stop it, then start it
				yield* addInstance(sampleInput);

				// Subscribe to events before starting
				const sub = yield* subscribeToDaemonEvents;

				yield* startInstance("inst-1");

				// Verify status in state
				const inst = yield* getInstance("inst-1");
				expect(inst.status).toBe("starting");

				// Verify event was published (InstanceStatusChanged)
				const event = yield* Queue.take(sub);
				expect(event._tag).toBe("InstanceStatusChanged");
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
		);
	});

	describe("stopInstance", () => {
		it.scoped("sets status to 'stopped' and publishes event", () =>
			Effect.gen(function* () {
				yield* addInstance(sampleInput);

				// Subscribe to events before stopping
				const sub = yield* subscribeToDaemonEvents;

				yield* stopInstance("inst-1");

				// Verify status in state
				const inst = yield* getInstance("inst-1");
				expect(inst.status).toBe("stopped");

				// Verify event was published
				const event = yield* Queue.take(sub);
				expect(event._tag).toBe("InstanceStatusChanged");
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
		);
	});

	describe("updateInstance", () => {
		it.scoped("merges partial updates into existing instance", () =>
			Effect.gen(function* () {
				yield* addInstance(sampleInput);

				yield* updateInstance("inst-1", {
					name: "Updated Name",
					port: 4001,
				});

				const inst = yield* getInstance("inst-1");
				expect(inst.name).toBe("Updated Name");
				expect(inst.port).toBe(4001);
				// Fields not updated should remain unchanged
				expect(inst.managed).toBe(true);
				expect(inst.id).toBe("inst-1");
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
		);

		it.scoped("publishes status changed event", () =>
			Effect.gen(function* () {
				yield* addInstance(sampleInput);
				const sub = yield* subscribeToDaemonEvents;

				yield* updateInstance("inst-1", { name: "New Name" });

				const event = yield* Queue.take(sub);
				expect(event._tag).toBe("InstanceStatusChanged");
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
		);

		it.scoped("can update status field", () =>
			Effect.gen(function* () {
				yield* addInstance(sampleInput);

				yield* updateInstance("inst-1", { status: "healthy" });

				const inst = yield* getInstance("inst-1");
				expect(inst.status).toBe("healthy");
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
		);
	});

	describe("persistConfig", () => {
		it.scoped("publishes ConfigChanged event", () =>
			Effect.gen(function* () {
				const sub = yield* subscribeToDaemonEvents;

				yield* persistConfig;

				const event = yield* Queue.take(sub);
				expect(event._tag).toBe("ConfigChanged");
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
		);
	});

	describe("getExternalUrl", () => {
		it.scoped("returns URL with daemon host and instance port", () =>
			Effect.gen(function* () {
				yield* addInstance(sampleInput);

				const url = yield* getExternalUrl("inst-1", "my-host.example.com");
				expect(url).toBe("http://my-host.example.com:3001");
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
		);

		it.scoped("returns null for non-existent instance", () =>
			Effect.gen(function* () {
				const url = yield* getExternalUrl("does-not-exist", "host");
				expect(url).toBeNull();
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
		);
	});

	describe("getInstanceUrl", () => {
		it.scoped("returns localhost URL with instance port", () =>
			Effect.gen(function* () {
				yield* addInstance(sampleInput);

				const url = yield* getInstanceUrl("inst-1");
				expect(url).toBe("http://localhost:3001");
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
		);

		it.scoped("returns null for non-existent instance", () =>
			Effect.gen(function* () {
				const url = yield* getInstanceUrl("does-not-exist");
				expect(url).toBeNull();
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
		);
	});
});
