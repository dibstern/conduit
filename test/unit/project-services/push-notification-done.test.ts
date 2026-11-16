// Regression tests proving that push notifications are sent for "done" and
// "error" events regardless of which code path produces them.
//
// Root cause: `done` messages from the status poller's `became_idle` handler
// reached session viewers but never the push manager, because the SSE
// translator returns ok:false for session.status:idle and the inline push code
// in sse-wiring.ts was never reached for them.
//
// Fix: sendPushForEvent() is extracted from sse-wiring.ts so the status-poller
// path (monitoring-wiring.ts) calls it for its done/error events too.

import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { sendPushForEvent } from "../../../src/lib/provider/opencode/sse-wiring.js";

function createMockPushManager() {
	return {
		sendToAll: vi.fn().mockResolvedValue(undefined),
	};
}

describe("sendPushForEvent", () => {
	it("sends push notification for done events", () => {
		const push = createMockPushManager();
		sendPushForEvent(
			push,
			{ type: "done", sessionId: "s1", code: 0 },
			createSilentLogger(),
		);

		expect(push.sendToAll).toHaveBeenCalledWith({
			type: "done",
			title: "Response complete",
			body: "Agent finished its response.",
			tag: "opencode-done",
		});
	});

	it("sends push notification for error events with message", () => {
		const push = createMockPushManager();
		sendPushForEvent(
			push,
			{
				type: "done",
				sessionId: "s1",
				code: 1,
				error: "Something broke",
			},
			createSilentLogger(),
		);

		expect(push.sendToAll).toHaveBeenCalledWith({
			type: "error",
			title: "Error",
			body: "Something broke",
			tag: "opencode-error",
		});
	});

	it("sends push notification for error events with fallback body", () => {
		const push = createMockPushManager();
		sendPushForEvent(
			push,
			{ type: "done", sessionId: "s1", code: 1, error: "" },
			createSilentLogger(),
		);

		expect(push.sendToAll).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "error",
				body: "An error occurred",
			}),
		);
	});

	it("does not send push for non-notification event types", () => {
		const push = createMockPushManager();
		sendPushForEvent(
			push,
			{ type: "delta", sessionId: "s1", text: "hello" },
			createSilentLogger(),
		);
		sendPushForEvent(
			push,
			{ type: "tool_start", sessionId: "s1", id: "t1", name: "Bash" },
			createSilentLogger(),
		);

		expect(push.sendToAll).not.toHaveBeenCalled();
	});

	it("logs push send failure without throwing", async () => {
		const push = {
			sendToAll: vi.fn().mockRejectedValue(new Error("network error")),
		};
		const warnSpy = vi.fn();
		const log = { ...createSilentLogger(), warn: warnSpy };

		// Should not throw
		sendPushForEvent(push, { type: "done", sessionId: "s1", code: 0 }, log);

		// Wait for the rejected promise to be caught
		await vi.waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Push send failed"),
			);
		});
	});
});
