// biome-ignore-all lint/suspicious/noExplicitAny: test mocks use `as any` for partial service shapes
import { describe, it } from "@effect/vitest";
import { Effect, Layer, PubSub } from "effect";
import { expect, vi } from "vitest";
import { makePinoLoggerLive } from "../../../src/lib/domain/daemon/Layers/pino-logger-layer.js";
import {
	DaemonEvent,
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	LoggerTag,
	PollerManagerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import type { MonitoringState } from "../../../src/lib/relay/monitoring-types.js";
import {
	handleSessionCreated,
	makeSessionLifecycleWiringLive,
	SessionLifecycleHistoryRebuildError,
} from "../../../src/lib/relay/session-lifecycle-wiring.js";
import {
	makeMockOpenCodeAPI,
	makeMockStatusPoller,
} from "../../helpers/mock-factories.js";

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
		statusPoller: makeMockStatusPoller({
			isProcessing: vi.fn(() => Effect.succeed(false)),
			clearMessageActivity: vi.fn(() => Effect.void),
		}),
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

function makeServiceLifecycleTestLayer(
	services: ReturnType<typeof makeMockServices>,
	deps: ReturnType<typeof makeMockDeps>,
	api = makeMockOpenCodeAPI(),
) {
	const wiringLayer = makeSessionLifecycleWiringLive({
		translator: deps.translator as any,
		sseTracker: deps.sseTracker as any,
		getMonitoringState: deps.getMonitoringState,
		setMonitoringState: deps.setMonitoringState,
	});

	const baseLayer = Layer.mergeAll(
		Layer.succeed(WebSocketHandlerTag, services.wsHandler as any),
		Layer.succeed(OpenCodeAPITag, api),
		Layer.succeed(PollerManagerTag, services.pollerManager as any),
		Layer.succeed(StatusPollerTag, services.statusPoller),
		Layer.succeed(LoggerTag, services.log),
		makeSessionManagerStateLive(),
		DaemonEventBusLive,
	);

	return Layer.mergeAll(wiringLayer, SessionManagerServiceLive).pipe(
		Layer.provide(baseLayer),
	);
}

function makePinoSpies() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: vi.fn(),
	};
}

function mockPino() {
	const root = makePinoSpies();
	const child = makePinoSpies();
	root.child.mockReturnValue(child);
	return { root, child };
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// AUDIT FIX (AP-1): Use `it.live` (not `it.scoped`) because subscriber fibers
// use real async REST calls wrapped in Effect.tryPromise. TestClock freezes
// Effect.sleep — tests would hang. Pipe `Effect.scoped` explicitly for stream
// subscription scope.

describe("SessionLifecycleWiringLive", () => {
	it.effect("maps history rebuild rejection into a typed lifecycle error", () =>
		Effect.gen(function* () {
			const services = makeMockServices();
			const deps = makeMockDeps();
			const cause = new Error("history unavailable");
			services.client.session.messages.mockRejectedValue(cause);

			const result = yield* Effect.either(
				handleSessionCreated("s-reject", {
					translator: deps.translator as any,
					client: services.client,
					pollerManager: services.pollerManager,
					sessionLog: services.log,
				}),
			);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left).toBeInstanceOf(SessionLifecycleHistoryRebuildError);
				expect(result.left._tag).toBe("SessionLifecycleHistoryRebuildError");
				expect(result.left.sessionId).toBe("s-reject");
				expect(result.left.operation).toBe("rebuildTranslatorFromHistory");
				expect(result.left.cause).toBe(cause);
			}
			expect(deps.translator.reset).toHaveBeenCalledWith("s-reject");
			expect(deps.translator.rebuildStateFromHistory).not.toHaveBeenCalled();
			expect(services.pollerManager.startPolling).not.toHaveBeenCalled();
		}),
	);

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

	it.live(
		"SessionManagerServiceLive createSession drives lifecycle wiring without SessionEventBridgeLive",
		() => {
			const services = makeMockServices();
			const deps = makeMockDeps();
			const api = makeMockOpenCodeAPI();
			const createdSession = {
				id: "service-created",
				projectID: "project-1",
				directory: "/tmp/project-1",
				title: "Service Created",
				version: "v1",
				time: { created: 1, updated: 1 },
			} satisfies Awaited<ReturnType<typeof api.session.create>>;
			const seedMessages = [
				{
					id: "m1",
					role: "assistant",
					sessionID: "service-created",
					parts: [{ id: "p1", type: "text" }],
				},
			] satisfies Awaited<ReturnType<typeof api.session.messages>>;
			vi.mocked(api.session.create).mockResolvedValue(createdSession);
			vi.mocked(api.session.messages).mockResolvedValue(seedMessages);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				yield* Effect.sleep("10 millis");
				yield* service.createSession("Service Created");
				yield* Effect.sleep("50 millis");

				expect(api.session.create).toHaveBeenCalledWith({
					title: "Service Created",
				});
				expect(api.session.messages).toHaveBeenCalledWith("service-created");
				expect(deps.translator.reset).toHaveBeenCalledWith("service-created");
				expect(deps.translator.rebuildStateFromHistory).toHaveBeenCalledWith(
					"service-created",
					expect.any(Array),
				);
				expect(services.pollerManager.startPolling).toHaveBeenCalledWith(
					"service-created",
					expect.any(Array),
				);
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Layer.fresh(makeServiceLifecycleTestLayer(services, deps, api)),
				),
			);
		},
	);

	it.live(
		"SessionManagerServiceLive deleteSession drives lifecycle cleanup without SessionEventBridgeLive",
		() => {
			const services = makeMockServices();
			const deps = makeMockDeps();
			const api = makeMockOpenCodeAPI();
			deps.monitoringState.current = {
				sessions: new Map([["service-deleted", { phase: "idle" as const }]]),
			};

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				yield* Effect.sleep("10 millis");
				yield* service.deleteSession("service-deleted");
				yield* Effect.sleep("50 millis");

				expect(api.session.delete).toHaveBeenCalledWith("service-deleted");
				expect(deps.translator.reset).toHaveBeenCalledWith("service-deleted");
				expect(services.pollerManager.stopPolling).toHaveBeenCalledWith(
					"service-deleted",
				);
				expect(services.statusPoller.clearMessageActivity).toHaveBeenCalledWith(
					"service-deleted",
				);
				expect(deps.sseTracker.remove).toHaveBeenCalledWith("service-deleted");
				expect(
					deps.monitoringState.current.sessions.has("service-deleted"),
				).toBe(false);
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Layer.fresh(makeServiceLifecycleTestLayer(services, deps, api)),
				),
			);
		},
	);

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
		"keeps lifecycle subscriber alive after history rebuild failure",
		() => {
			const services = makeMockServices();
			const deps = makeMockDeps();
			const pino = mockPino();
			services.client.session.messages.mockRejectedValue(
				new Error("history unavailable"),
			);
			deps.monitoringState.current = {
				sessions: new Map([["s-after-failure", { phase: "idle" as const }]]),
			};

			return Effect.gen(function* () {
				const bus = yield* DaemonEventBusTag;
				yield* Effect.sleep("10 millis");
				yield* PubSub.publish(
					bus,
					DaemonEvent.SessionCreated({ sessionId: "s-fails" }),
				);
				yield* Effect.sleep("50 millis");
				yield* PubSub.publish(
					bus,
					DaemonEvent.SessionDeleted({ sessionId: "s-after-failure" }),
				);
				yield* Effect.sleep("50 millis");

				expect(services.client.session.messages).toHaveBeenCalledWith(
					"s-fails",
				);
				expect(services.pollerManager.stopPolling).toHaveBeenCalledWith(
					"s-after-failure",
				);
				expect(services.statusPoller.clearMessageActivity).toHaveBeenCalledWith(
					"s-after-failure",
				);
				expect(deps.sseTracker.remove).toHaveBeenCalledWith("s-after-failure");
				expect(
					deps.monitoringState.current.sessions.has("s-after-failure"),
				).toBe(false);
				expect(pino.root.child).toHaveBeenCalledWith(
					expect.objectContaining({
						sessionId: "s-fails",
						operation: "rebuildTranslatorFromHistory",
					}),
				);
				expect(pino.child.error).toHaveBeenCalled();
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.fresh(makeTestLayer(services, deps))),
				Effect.provide(makePinoLoggerLive(pino.root as any)),
			);
		},
	);

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
		"does not start polling when delete arrives during create history rebuild",
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

				expect(services.pollerManager.stopPolling).toHaveBeenCalledWith("s1");
				expect(services.pollerManager.startPolling).not.toHaveBeenCalled();
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.fresh(makeTestLayer(services, deps))),
			);
		},
	);

	it.live(
		"starts polling for a recreated session after invalidating a stale create",
		() => {
			const services = makeMockServices();
			const deps = makeMockDeps();
			const resolvers: Array<(value: unknown[]) => void> = [];
			services.client.session.messages.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolvers.push(resolve);
					}),
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
				yield* PubSub.publish(
					bus,
					DaemonEvent.SessionCreated({ sessionId: "s1" }),
				);
				yield* Effect.sleep("50 millis");

				resolvers[0]?.([
					{ id: "old-message", role: "assistant", sessionID: "s1", parts: [] },
				]);
				resolvers[1]?.([
					{ id: "new-message", role: "assistant", sessionID: "s1", parts: [] },
				]);
				yield* Effect.sleep("50 millis");

				expect(services.pollerManager.startPolling).toHaveBeenCalledTimes(1);
				expect(services.pollerManager.startPolling).toHaveBeenCalledWith("s1", [
					expect.objectContaining({ id: "new-message" }),
				]);
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
