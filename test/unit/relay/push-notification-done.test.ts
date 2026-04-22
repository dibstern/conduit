// ─── Push Notifications for Done/Error Events ───────────────────────────────
// Regression tests proving that push notifications are sent for "done" and
// "error" events regardless of which code path produces them.
//
// Root cause: `done` messages are produced by the status poller's `became_idle`
// handler in relay-stack.ts, which routes them through processEvent →
// applyPipelineResult. This pipeline sends the WS message to session viewers
// but NEVER calls pushManager.sendToAll(). The push notification code in
// sse-wiring.ts (lines 266-278) is dead code for "done" events because the
// SSE translator returns ok:false for session.status:idle — handleSSEEvent
// exits early and never reaches the push code.
//
// Fix: extract sendPushForEvent() from the inline code in sse-wiring.ts so
// relay-stack.ts can call it for status-poller-produced done/error events.

import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { sendPushForEvent } from "../../../src/lib/relay/sse-wiring.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockPushManager() {
	return {
		sendToAll: vi.fn().mockResolvedValue(undefined),
	};
}

// ─── sendPushForEvent ────────────────────────────────────────────────────────

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
			title: "Task Complete",
			body: "Agent has finished processing.",
			tag: "opencode-done",
		});
	});

	it("sends push notification for error events with message", () => {
		const push = createMockPushManager();
		sendPushForEvent(
			push,
			{
				type: "error",
				sessionId: "s1",
				code: "SEND_FAILED",
				message: "Something broke",
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
			{ type: "error", sessionId: "s1", code: "UNKNOWN", message: "" },
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
			{ type: "status", sessionId: "s1", status: "processing" },
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
