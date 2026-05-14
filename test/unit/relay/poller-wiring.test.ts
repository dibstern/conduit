import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
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
		const broadcast = vi.fn();
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
				broadcast,
				broadcastPerSessionEvent: vi.fn(),
				getClientsForSession: vi.fn(() => []),
				sendToSession: vi.fn(),
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
				wsHandler: {
					broadcastPerSessionEvent: vi.fn(),
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
		expect(broadcast).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "notification_event",
				eventType: "done",
				sessionId: "child-session",
			}),
		);
	});

	it("effect-owned production wiring reads parent map from SessionManagerService", async () => {
		let pollerEvents:
			| ((messages: RelayMessage[], sessionId: string) => void)
			| undefined;
		const broadcast = vi.fn();
		const pushManager = {
			sendToAll: vi.fn(async () => undefined),
		};

		const layer = Layer.mergeAll(
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
					broadcast,
					broadcastPerSessionEvent: vi.fn(),
					getClientsForSession: vi.fn(() => []),
					sendToSession: vi.fn(),
				} as never,
				pipelineDeps: {
					wsHandler: {
						broadcastPerSessionEvent: vi.fn(),
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
			}).pipe(Effect.provide(layer)),
		);

		pollerEvents?.(
			[{ type: "done", sessionId: "child-session", code: 0 }],
			"child-session",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(pushManager.sendToAll).not.toHaveBeenCalled();
		expect(broadcast).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "notification_event",
				eventType: "done",
				sessionId: "child-session",
			}),
		);
	});
});
