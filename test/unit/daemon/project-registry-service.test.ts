import { describe, it } from "@effect/vitest";
import { Effect, Layer, Queue } from "effect";
import { expect } from "vitest";
import {
	DaemonEventBusLive,
	subscribeToDaemonEvents,
} from "../../../src/lib/effect/daemon-pubsub.js";
import {
	addWithoutRelay,
	broadcastToAll,
	evictOldestSessions,
	isStarting,
	makeProjectRegistryLive,
	markReady,
	waitForRelay,
} from "../../../src/lib/effect/project-registry-service.js";
import {
	type RelayCache,
	RelayCacheTag,
} from "../../../src/lib/effect/relay-cache.js";
import type { StoredProject } from "../../../src/lib/types.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

const testProject: StoredProject = {
	slug: "test-project",
	directory: "/tmp/test",
	title: "Test Project",
	lastUsed: Date.now(),
};

/** Stub RelayCache that records calls for assertions. */
const makeStubRelayCache = (): RelayCache => ({
	get: (_slug: string) =>
		Effect.succeed({
			slug: _slug,
			wsHandler: { handleUpgrade: () => {} },
			stop: () => {},
		}),
	invalidate: (_slug: string) => Effect.void,
});

/** Compose a test layer with ProjectRegistry, DaemonEventBus, and a stub RelayCache. */
const testLayer = Layer.mergeAll(
	makeProjectRegistryLive(),
	DaemonEventBusLive,
	Layer.succeed(RelayCacheTag, makeStubRelayCache()),
);

// ─── Tests: broadcastToAll ──────────────────────────────────────────────────

describe("broadcastToAll", () => {
	it.scoped("publishes a RelayBroadcast event to the event bus", () =>
		Effect.gen(function* () {
			const sub = yield* subscribeToDaemonEvents;
			yield* broadcastToAll({ type: "test", data: 42 });
			const event = yield* Queue.take(sub);
			expect(event._tag).toBe("RelayBroadcast");
			if (event._tag === "RelayBroadcast") {
				expect(event.message).toEqual({ type: "test", data: 42 });
			}
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});

// ─── Tests: waitForRelay ────────────────────────────────────────────────────

describe("waitForRelay", () => {
	it.scoped("resolves immediately if project is already Ready", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(testProject);
			yield* markReady(testProject.slug);
			// Should not timeout — project is already ready
			const result = yield* waitForRelay(testProject.slug, 1000);
			// waitForRelay returns void on success
			expect(result).toBeUndefined();
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("fails with ProjectNotFound for unknown slug", () =>
		Effect.gen(function* () {
			const result = yield* waitForRelay("nonexistent", 1000).pipe(Effect.flip);
			expect(result._tag).toBe("ProjectNotFound");
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("waits for InstanceStatusChanged then verifies Ready", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(testProject);

			// Fork the wait in background
			const fiber = yield* Effect.fork(waitForRelay(testProject.slug, 5000));

			// Simulate the project becoming ready (publishes InstanceStatusChanged)
			yield* markReady(testProject.slug);

			// The fiber should complete successfully
			yield* fiber.await;
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});

// ─── Tests: evictOldestSessions ─────────────────────────────────────────────

describe("evictOldestSessions", () => {
	it.effect("returns empty array (stub)", () =>
		Effect.gen(function* () {
			const result = yield* evictOldestSessions(5);
			expect(result).toEqual([]);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});

// ─── Tests: isStarting ─────────────────────────────────────────────────────

describe("isStarting", () => {
	it.effect("returns true for a project in Registering state", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(testProject);
			const result = yield* isStarting(testProject.slug);
			expect(result).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.effect("returns false for a project in Ready state", () =>
		Effect.gen(function* () {
			yield* addWithoutRelay(testProject);
			yield* markReady(testProject.slug);
			const result = yield* isStarting(testProject.slug);
			expect(result).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.effect("returns false for unknown slug", () =>
		Effect.gen(function* () {
			const result = yield* isStarting("nonexistent");
			expect(result).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});
