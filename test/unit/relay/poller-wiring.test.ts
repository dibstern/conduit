import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { wirePollers } from "../../../src/lib/relay/poller-wiring.js";
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
});
