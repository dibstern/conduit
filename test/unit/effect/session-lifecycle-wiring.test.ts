// biome-ignore-all lint/suspicious/noExplicitAny: test mocks use `as any` for partial service shapes
import { describe, it } from "@effect/vitest";
import { Effect, Layer, PubSub } from "effect";
import { expect, vi } from "vitest";
import {
	DaemonEvent,
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../../../src/lib/effect/daemon-pubsub.js";
import {
	LoggerTag,
	OpenCodeAPITag,
	PollerManagerTag,
	type StatusPollerShape,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import type { MonitoringState } from "../../../src/lib/relay/monitoring-types.js";
import { makeSessionLifecycleWiringLive } from "../../../src/lib/relay/session-lifecycle-wiring.js";

// ── Test Helpers ────────────────────────────────────────────────────────────

function makeMockDeps() {
	const monitoringState: { current: MonitoringState } = {
		current: { sessions: new Map() },
	};
	return {
		translator: {
			reset: vi.fn(),
			translate: vi.fn().mockReturnValue({ ok: false, reason: "test" }),
			getSeenParts: vi.fn().mockReturnValue(new Map()),
			rebuildStateFromHistory: vi.fn(),
		},
		sseTracker: {
			remove: vi.fn(),
			recordEvent: vi.fn(),
			getLastEventAt: vi.fn(),
		},
		getMonitoringState: () => monitoringState.current,
		setMonitoringState: (s: MonitoringState) => {
			monitoringState.current = s;
		},
		monitoringState,
	};
}

function makeMockServices() {
	return {
		wsHandler: {
			broadcast: vi.fn(),
			drain: vi.fn().mockResolvedValue(undefined),
		},
		client: {
			session: {
				messages: vi.fn().mockResolvedValue([]),
			},
		},
		pollerManager: {
			isPolling: vi.fn().mockReturnValue(false),
			startPolling: vi.fn(),
			stopPolling: vi.fn(),
		},
		statusPoller: {
			isProcessing: vi.fn().mockReturnValue(false),
			clearMessageActivity: vi.fn(),
		} satisfies StatusPollerShape,
		log: createSilentLogger(),
	};
}

// AUDIT FIX (AP-2): Create services/deps ONCE, share between test body and Layer.
function makeTestLayer(
	services: ReturnType<typeof makeMockServices>,
	deps: ReturnType<typeof makeMockDeps>,
) {
	const wiringLayer = makeSessionLifecycleWiringLive({
		translator: deps.translator as any,
		sseTracker: deps.sseTracker as any,
		getMonitoringState: deps.getMonitoringState,
		setMonitoringState: deps.setMonitoringState,
	});

	const bridgeLayers = Layer.mergeAll(
		Layer.succeed(WebSocketHandlerTag, services.wsHandler as any),
		Layer.succeed(OpenCodeAPITag, services.client as any),
		Layer.succeed(PollerManagerTag, services.pollerManager as any),
		Layer.succeed(StatusPollerTag, services.statusPoller),
		Layer.succeed(LoggerTag, services.log),
		DaemonEventBusLive,
	);

	return Layer.provideMerge(wiringLayer, bridgeLayers);
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// AUDIT FIX (AP-1): Use `it.live` (not `it.scoped`) because subscriber fibers
// use real async (Effect.promise wrapping REST calls). TestClock freezes
// Effect.sleep — tests would hang. Pipe `Effect.scoped` explicitly for stream
// subscription scope.

describe("SessionLifecycleWiringLive", () => {
	it.live("broadcasts RelayBroadcast to WebSocket handler", () => {
		const services = makeMockServices();
		const deps = makeMockDeps();
		const msg = { type: "session_list" as const, sessions: [], roots: true };

		return Effect.gen(function* () {
			const bus = yield* DaemonEventBusTag;
			// Allow subscriber fibers to start and subscribe to PubSub
			yield* Effect.sleep("10 millis");
			yield* PubSub.publish(bus, DaemonEvent.RelayBroadcast({ message: msg }));
			yield* Effect.sleep("10 millis");

			expect(services.wsHandler.broadcast).toHaveBeenCalledWith(msg);
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.fresh(makeTestLayer(services, deps))),
		);
	});

	it.live("resets translator and starts poller on SessionCreated", () => {
		const services = makeMockServices();
		const deps = makeMockDeps();
		services.client.session.messages.mockResolvedValue([
			{ parts: [{ id: "p1", type: "text" }] },
		]);

		return Effect.gen(function* () {
			const bus = yield* DaemonEventBusTag;
			yield* Effect.sleep("10 millis");
			yield* PubSub.publish(
				bus,
				DaemonEvent.SessionCreated({ sessionId: "s1" }),
			);
			yield* Effect.sleep("50 millis");

			expect(deps.translator.reset).toHaveBeenCalledWith("s1");
			expect(services.pollerManager.startPolling).toHaveBeenCalledWith(
				"s1",
				expect.any(Array),
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.fresh(makeTestLayer(services, deps))),
		);
	});

	it.live(
		"stops poller and cleans up monitoring state on SessionDeleted",
		() => {
			const services = makeMockServices();
			const deps = makeMockDeps();
			deps.monitoringState.current = {
				sessions: new Map([["s1", { phase: "idle" as const }]]),
			};

			return Effect.gen(function* () {
				const bus = yield* DaemonEventBusTag;
				yield* Effect.sleep("10 millis");
				yield* PubSub.publish(
					bus,
					DaemonEvent.SessionDeleted({ sessionId: "s1" }),
				);
				yield* Effect.sleep("10 millis");

				expect(deps.translator.reset).toHaveBeenCalledWith("s1");
				expect(services.pollerManager.stopPolling).toHaveBeenCalledWith("s1");
				expect(services.statusPoller.clearMessageActivity).toHaveBeenCalledWith(
					"s1",
				);
				expect(deps.sseTracker.remove).toHaveBeenCalledWith("s1");
				expect(deps.monitoringState.current.sessions.has("s1")).toBe(false);
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.fresh(makeTestLayer(services, deps))),
			);
		},
	);

	it.live(
		"create→delete in rapid succession: poller starts then stops (sequential processing)",
		() => {
			const services = makeMockServices();
			const deps = makeMockDeps();
			services.client.session.messages.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(() => resolve([{ parts: [] }]), 100),
					),
			);

			return Effect.gen(function* () {
				const bus = yield* DaemonEventBusTag;
				yield* Effect.sleep("10 millis");
				yield* PubSub.publish(
					bus,
					DaemonEvent.SessionCreated({ sessionId: "s1" }),
				);
				yield* PubSub.publish(
					bus,
					DaemonEvent.SessionDeleted({ sessionId: "s1" }),
				);
				yield* Effect.sleep("300 millis");

				expect(services.pollerManager.startPolling).toHaveBeenCalledWith(
					"s1",
					expect.any(Array),
				);
				expect(services.pollerManager.stopPolling).toHaveBeenCalledWith("s1");
				const startOrder =
					services.pollerManager.startPolling.mock.invocationCallOrder[0];
				const stopOrder =
					services.pollerManager.stopPolling.mock.invocationCallOrder[0];
				// biome-ignore lint/style/noNonNullAssertion: call count verified above
				expect(stopOrder).toBeGreaterThan(startOrder!);
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.fresh(makeTestLayer(services, deps))),
			);
		},
	);

	it.live("skips startPolling when no seed messages returned", () => {
		const services = makeMockServices();
		const deps = makeMockDeps();
		services.client.session.messages.mockResolvedValue(undefined);

		return Effect.gen(function* () {
			const bus = yield* DaemonEventBusTag;
			yield* Effect.sleep("10 millis");
			yield* PubSub.publish(
				bus,
				DaemonEvent.SessionCreated({ sessionId: "s1" }),
			);
			yield* Effect.sleep("50 millis");

			expect(deps.translator.reset).toHaveBeenCalledWith("s1");
			expect(services.pollerManager.startPolling).not.toHaveBeenCalled();
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.fresh(makeTestLayer(services, deps))),
		);
	});
});
