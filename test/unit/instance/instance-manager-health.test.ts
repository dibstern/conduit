// test/unit/instance/instance-manager-health.test.ts
// Tests for health polling and restart scheduling in InstanceManager Effect service.
import { describe, it } from "@effect/vitest";
import {
	Duration,
	Effect,
	FiberMap,
	HashMap,
	Layer,
	Option,
	PubSub,
	Queue,
	Ref,
	TestClock,
} from "effect";
import { expect } from "vitest";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import {
	type DaemonEvent,
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { InstanceHealthCheckLive } from "../../../src/lib/domain/daemon/Services/instance-health-service.js";
import {
	type AddInstanceInput,
	addInstance,
	cancelInstanceFibers,
	InstanceManagerStateTag,
	makeInstanceManagerStateLive,
	PollerFibersTag,
	removeInstance,
	restartInstance,
	scheduleRestart,
	startHealthPoller,
	stopHealthPoller,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

const testConfig = {
	maxInstances: 10,
	healthPollIntervalMs: 5000,
	maxRestartsPerWindow: 3,
	restartWindowMs: 60_000,
};

const testLayer = Layer.mergeAll(
	makeInstanceManagerStateLive(testConfig),
	DaemonEventBusLive,
	ConfigPersistenceNoopLive,
	InstanceHealthCheckLive,
);

const mkInstance = (
	id: string,
	port: number,
	managed = false,
): AddInstanceInput => ({
	id,
	name: `Instance ${id}`,
	port,
	managed,
});

// ─── Health Polling ──────────────────────────────────────────────────────────

describe("InstanceManager health polling", () => {
	it.scoped("startHealthPoller registers a fiber in FiberMap", () =>
		Effect.gen(function* () {
			yield* addInstance(mkInstance("inst-1", 4096));
			yield* startHealthPoller("inst-1");
			const fibers = yield* PollerFibersTag;
			const exists = yield* FiberMap.has(fibers, "poller:inst-1");
			expect(exists).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("stopHealthPoller removes the polling fiber", () =>
		Effect.gen(function* () {
			yield* addInstance(mkInstance("inst-1", 4096));
			yield* startHealthPoller("inst-1");
			yield* stopHealthPoller("inst-1");
			const fibers = yield* PollerFibersTag;
			const exists = yield* FiberMap.has(fibers, "poller:inst-1");
			expect(exists).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped(
		"marks instance unhealthy on fetch failure after poll interval",
		() =>
			Effect.gen(function* () {
				// Port 1 will never have a real server → fetch fails → unhealthy
				yield* addInstance(mkInstance("inst-1", 1));
				// Manually set status to healthy first so we see the transition
				const stateRef = yield* InstanceManagerStateTag;
				yield* Ref.update(stateRef, (s) => ({
					...s,
					instances: HashMap.modify(s.instances, "inst-1", (inst) => ({
						...inst,
						status: "healthy" as const,
					})),
				}));
				yield* startHealthPoller("inst-1");
				// Advance past poll interval
				yield* TestClock.adjust(Duration.seconds(6));
				const state = yield* Ref.get(stateRef);
				const inst = HashMap.get(state.instances, "inst-1");
				expect(Option.isSome(inst)).toBe(true);
				if (Option.isSome(inst)) {
					expect(inst.value.status).toBe("unhealthy");
				}
			}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("publishes InstanceStatusChanged on status transition", () =>
		Effect.gen(function* () {
			const bus = yield* DaemonEventBusTag;
			const dequeue = yield* PubSub.subscribe(bus);

			yield* addInstance(mkInstance("inst-1", 1));
			// Set to healthy, so when poll detects failure we get a transition
			const stateRef = yield* InstanceManagerStateTag;
			yield* Ref.update(stateRef, (s) => ({
				...s,
				instances: HashMap.modify(s.instances, "inst-1", (inst) => ({
					...inst,
					status: "healthy" as const,
				})),
			}));
			yield* startHealthPoller("inst-1");
			yield* TestClock.adjust(Duration.seconds(6));

			// Drain events
			const events: Array<DaemonEvent> = [];
			let next = yield* Queue.poll(dequeue);
			while (Option.isSome(next)) {
				events.push(next.value);
				next = yield* Queue.poll(dequeue);
			}

			const statusEvents = events.filter(
				(e) => e._tag === "InstanceStatusChanged",
			);
			expect(statusEvents.length).toBeGreaterThanOrEqual(1);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("stops polling if instance removed during polling", () =>
		Effect.gen(function* () {
			yield* addInstance(mkInstance("inst-1", 1));
			yield* startHealthPoller("inst-1");
			yield* removeInstance("inst-1");
			// Poller fiber should be gone (removeInstance cancels it)
			const fibers = yield* PollerFibersTag;
			const exists = yield* FiberMap.has(fibers, "poller:inst-1");
			expect(exists).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});

// ─── Restart Scheduling ──────────────────────────────────────────────────────

describe("InstanceManager restart scheduling", () => {
	it.scoped("scheduleRestart registers a restart fiber", () =>
		Effect.gen(function* () {
			yield* addInstance(mkInstance("inst-1", 4096));
			// Set to unhealthy so restart makes sense
			const stateRef = yield* InstanceManagerStateTag;
			yield* Ref.update(stateRef, (s) => ({
				...s,
				instances: HashMap.modify(s.instances, "inst-1", (inst) => ({
					...inst,
					status: "unhealthy" as const,
				})),
			}));
			yield* scheduleRestart("inst-1");
			const fibers = yield* PollerFibersTag;
			const exists = yield* FiberMap.has(fibers, "restart:inst-1");
			expect(exists).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("restartInstance directly resets status to starting", () =>
		Effect.gen(function* () {
			yield* addInstance(mkInstance("inst-1", 4096));
			const stateRef = yield* InstanceManagerStateTag;
			yield* Ref.update(stateRef, (s) => ({
				...s,
				instances: HashMap.modify(s.instances, "inst-1", (inst) => ({
					...inst,
					status: "unhealthy" as const,
				})),
			}));
			yield* restartInstance("inst-1");
			const state = yield* Ref.get(stateRef);
			const inst = HashMap.get(state.instances, "inst-1");
			expect(Option.isSome(inst)).toBe(true);
			if (Option.isSome(inst)) {
				expect(inst.value.status).toBe("starting");
				expect(inst.value.restartCount).toBe(1);
			}
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("scheduleRestart records timestamp and registers fiber", () =>
		Effect.gen(function* () {
			yield* addInstance(mkInstance("inst-1", 4096));
			const stateRef = yield* InstanceManagerStateTag;
			yield* Ref.update(stateRef, (s) => ({
				...s,
				instances: HashMap.modify(s.instances, "inst-1", (inst) => ({
					...inst,
					status: "unhealthy" as const,
				})),
			}));
			yield* scheduleRestart("inst-1");
			// Verify restart fiber was registered
			const fibers = yield* PollerFibersTag;
			const exists = yield* FiberMap.has(fibers, "restart:inst-1");
			expect(exists).toBe(true);
			// Verify timestamp was recorded
			const state = yield* Ref.get(stateRef);
			const timestamps = HashMap.get(state.restartTimestamps, "inst-1");
			expect(Option.isSome(timestamps)).toBe(true);
			if (Option.isSome(timestamps)) {
				expect(timestamps.value.length).toBe(1);
			}
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("gives up after maxRestartsPerWindow exceeded", () =>
		Effect.gen(function* () {
			const bus = yield* DaemonEventBusTag;
			const dequeue = yield* PubSub.subscribe(bus);

			yield* addInstance(mkInstance("inst-1", 4096));
			const stateRef = yield* InstanceManagerStateTag;

			// Pre-fill restart timestamps to be at the limit
			yield* Ref.update(stateRef, (s) => ({
				...s,
				instances: HashMap.modify(s.instances, "inst-1", (inst) => ({
					...inst,
					status: "unhealthy" as const,
				})),
				restartTimestamps: HashMap.set(
					s.restartTimestamps,
					"inst-1",
					[0, 0, 0] as ReadonlyArray<number>, // 3 = maxRestartsPerWindow
				),
			}));

			yield* scheduleRestart("inst-1");

			// Should have been marked stopped immediately
			const state = yield* Ref.get(stateRef);
			const inst = HashMap.get(state.instances, "inst-1");
			expect(Option.isSome(inst)).toBe(true);
			if (Option.isSome(inst)) {
				expect(inst.value.status).toBe("stopped");
			}

			// Should have published an InstanceError event
			const events: Array<DaemonEvent> = [];
			let next = yield* Queue.poll(dequeue);
			while (Option.isSome(next)) {
				events.push(next.value);
				next = yield* Queue.poll(dequeue);
			}
			const errorEvents = events.filter((e) => e._tag === "InstanceError");
			expect(errorEvents.length).toBe(1);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("cancelInstanceFibers removes both poller and restart fibers", () =>
		Effect.gen(function* () {
			yield* addInstance(mkInstance("inst-1", 4096));
			const stateRef = yield* InstanceManagerStateTag;
			yield* Ref.update(stateRef, (s) => ({
				...s,
				instances: HashMap.modify(s.instances, "inst-1", (inst) => ({
					...inst,
					status: "unhealthy" as const,
				})),
			}));
			yield* startHealthPoller("inst-1");
			yield* scheduleRestart("inst-1");

			yield* cancelInstanceFibers("inst-1");

			const fibers = yield* PollerFibersTag;
			const pollerExists = yield* FiberMap.has(fibers, "poller:inst-1");
			const restartExists = yield* FiberMap.has(fibers, "restart:inst-1");
			expect(pollerExists).toBe(false);
			expect(restartExists).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("removeInstance cancels both poller and restart fibers", () =>
		Effect.gen(function* () {
			yield* addInstance(mkInstance("inst-1", 4096));
			const stateRef = yield* InstanceManagerStateTag;
			yield* Ref.update(stateRef, (s) => ({
				...s,
				instances: HashMap.modify(s.instances, "inst-1", (inst) => ({
					...inst,
					status: "unhealthy" as const,
				})),
			}));
			yield* startHealthPoller("inst-1");
			yield* scheduleRestart("inst-1");

			yield* removeInstance("inst-1");

			const fibers = yield* PollerFibersTag;
			const pollerExists = yield* FiberMap.has(fibers, "poller:inst-1");
			const restartExists = yield* FiberMap.has(fibers, "restart:inst-1");
			expect(pollerExists).toBe(false);
			expect(restartExists).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});
