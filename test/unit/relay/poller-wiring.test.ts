import { Chunk, Effect, Layer, PubSub, Queue, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Alert } from "../../../src/lib/contracts/ws-rpc.js";
import { AlertsTag } from "../../../src/lib/domain/relay/Services/alerts.js";
import { StatusPollerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	wirePollers,
	wirePollersEffect,
} from "../../../src/lib/relay/poller-wiring.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

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
				notifySSEEvent: vi.fn(),
			},
			sseStream: {
				on: vi.fn(),
			},
			statusPoller: {
				markMessageActivity: vi.fn(),
			} as never,
			wsHandler: {
				getClientsForSession: vi.fn(() => []),
			} as never,
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
			PubSub.subscribe(alerts).pipe(Scope.extend(Effect.runSync(Scope.make()))),
		);
		const pushManager = {
			sendToAll: vi.fn(async () => undefined),
		};

		const layer = Layer.mergeAll(
			Layer.succeed(AlertsTag, alerts),
			Layer.succeed(SessionManagerServiceTag, {
				getSessionParentMap: () =>
					Effect.succeed(new Map([["child-session", "parent-session"]])),
			} as never),
			Layer.succeed(StatusPollerTag, {
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
					notifySSEEvent: vi.fn(),
				},
				sseStream: {
					on: vi.fn(),
				},
				wsHandler: {
					getClientsForSession: vi.fn(() => []),
				} as never,
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
			}).pipe(Effect.provide(layer)),
		);

		pollerEvents?.(
			[{ type: "done", sessionId: "child-session", code: 0 }],
			"child-session",
		);
		// Flush handling of the child event before checking that it produced no notification.
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(pushManager.sendToAll).not.toHaveBeenCalled();
		expect(Chunk.toArray(Effect.runSync(Queue.takeAll(alertsSeen)))).toEqual(
			[],
		);
	});
});
