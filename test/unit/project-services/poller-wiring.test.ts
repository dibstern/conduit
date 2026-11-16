import { Effect, Exit, Layer, PubSub, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Alert } from "../../../src/lib/contracts/ws-rpc.js";
import { AlertsTag } from "../../../src/lib/domain/project-services/Services/alerts.js";
import {
	ConfigTag,
	StatusPollerTag,
} from "../../../src/lib/domain/project-services/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/project-services/Services/session-manager-service.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/project-services/Services/session-overrides-state.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	wirePollers,
	wirePollersEffect,
} from "../../../src/lib/provider/opencode/poller-wiring.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";
import {
	makeMockConfig,
	mockSessionManagers,
} from "../../helpers/mock-factories.js";

describe("wirePollers", () => {
	it("uses the service-backed parent map when suppressing subagent done notifications", () => {
		let pollerEvents:
			| ((messages: RelayMessage[], sessionId: string) => void)
			| undefined;
		const pushManager = {
			sendToAll: vi.fn(async () => undefined),
		};

		wirePollers({
			pollerManager: {
				on: vi.fn((_event, callback) => {
					pollerEvents = callback;
				}),
				off: vi.fn(),
				notifySSEEvent: vi.fn(),
			},
			sseStream: {
				on: vi.fn(),
				off: vi.fn(),
			},
			statusPoller: {
				markMessageActivity: vi.fn(),
			} as never,
			hasViewers: () => false,
			sessionService: {
				getSessionParentMap: () =>
					new Map([["child-session", "parent-session"]]),
			},
			pipelineDeps: {
				processingTimeouts: {
					clearProcessingTimeout: vi.fn(),
					resetProcessingTimeout: vi.fn(),
				},
				log: createSilentLogger(),
			},
			sseTracker: {
				recordEvent: vi.fn(),
			} as never,
			config: {
				pushManager: pushManager as never,
				slug: "project",
			},
			pollerLog: createSilentLogger(),
		});

		pollerEvents?.(
			[{ type: "done", sessionId: "child-session", code: 0 }],
			"child-session",
		);

		expect(pushManager.sendToAll).not.toHaveBeenCalled();
	});

	it("effect-owned production wiring reads parent map from SessionManagerService", async () => {
		let pollerEvents:
			| ((messages: RelayMessage[], sessionId: string) => void)
			| undefined;
		const alerts = Effect.runSync(PubSub.unbounded<Alert>());
		const alertsSeen = Effect.runSync(
			PubSub.subscribe(alerts).pipe(
				Scope.provide(Effect.runSync(Scope.make())),
			),
		);
		const pushManager = {
			sendToAll: vi.fn(async () => undefined),
		};

		const layer = Layer.mergeAll(
			Layer.succeed(AlertsTag)(alerts),
			Layer.succeed(SessionManagerServiceTag)(
				mockSessionManagers({
					getSessionParentMap: () =>
						Effect.succeed(new Map([["child-session", "parent-session"]])),
				} as never),
			),
			Layer.succeed(ConfigTag)(makeMockConfig()),
			Layer.succeed(StatusPollerTag)({
				markMessageActivity: vi.fn(),
			} as never),
			makeOverridesStateLive(),
		);

		await Effect.runPromise(
			wirePollersEffect({
				pollerManager: {
					on: vi.fn((_event, callback) => {
						pollerEvents = callback;
					}),
					off: vi.fn(),
					notifySSEEvent: vi.fn(),
				},
				sseStream: {
					on: vi.fn(),
					off: vi.fn(),
				},
				hasViewers: () => false,
				pipelineDeps: {
					log: createSilentLogger(),
				},
				sseTracker: {
					recordEvent: vi.fn(),
				} as never,
				config: {
					pushManager: pushManager as never,
					slug: "project",
				},
				pollerLog: createSilentLogger(),
			}).pipe(Effect.provide(layer), Effect.scoped),
		);

		pollerEvents?.(
			[{ type: "done", sessionId: "child-session", code: 0 }],
			"child-session",
		);
		// Flush handling of the child event before checking that it produced no notification.
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(pushManager.sendToAll).not.toHaveBeenCalled();
		expect([
			...Effect.runSync(PubSub.takeUpTo(alertsSeen, Number.POSITIVE_INFINITY)),
		]).toEqual([]);
	});

	// Lane 16o row 109: a relay replaced while the poller manager outlives it would
	// handle each batch twice if its listeners stayed behind.
	it("drops its poller and SSE listeners when the relay's scope closes", async () => {
		const pollerListeners = new Set<(...args: never[]) => void>();
		const sseListeners = new Set<(...args: never[]) => void>();
		const markMessageActivity = vi.fn();
		const layer = Layer.mergeAll(
			Layer.succeed(AlertsTag)(Effect.runSync(PubSub.unbounded<Alert>())),
			Layer.succeed(SessionManagerServiceTag)(mockSessionManagers({} as never)),
			Layer.succeed(ConfigTag)(makeMockConfig()),
			Layer.succeed(StatusPollerTag)({ markMessageActivity } as never),
			makeOverridesStateLive(),
		);
		const scope = Effect.runSync(Scope.make());
		await Effect.runPromise(
			wirePollersEffect({
				pollerManager: {
					on: (_event, callback) => void pollerListeners.add(callback),
					off: (_event, callback) => void pollerListeners.delete(callback),
					notifySSEEvent: vi.fn(),
				},
				sseStream: {
					on: (_event, callback) => void sseListeners.add(callback),
					off: (_event, callback) => void sseListeners.delete(callback),
				},
				hasViewers: () => false,
				pipelineDeps: { log: createSilentLogger() },
				sseTracker: { recordEvent: vi.fn() } as never,
				config: { slug: "project" },
				pollerLog: createSilentLogger(),
			}).pipe(Effect.provide(layer), Scope.provide(scope)),
		);
		expect([pollerListeners.size, sseListeners.size]).toEqual([1, 1]);

		await Effect.runPromise(Scope.close(scope, Exit.void));

		expect([pollerListeners.size, sseListeners.size]).toEqual([0, 0]);
	});
});
