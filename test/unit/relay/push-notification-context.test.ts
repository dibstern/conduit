// ─── Push Notification Context & Session Navigation Tests ───────────────────
// Tests for sendPushForEvent with the new PushEventContext parameter (slug and
// sessionId forwarding to push payload) and resolveNotifications with the
// sessionId parameter for cross-session notification payloads.
//
// Kept in a separate file to avoid modifying existing test files.

import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { resolveNotifications } from "../../../src/lib/relay/notification-policy.js";
import { sendPushForEvent } from "../../../src/lib/relay/sse-wiring.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockPushManager() {
	return {
		sendToAll: vi.fn().mockResolvedValue(undefined),
	};
}

// ─── sendPushForEvent with context ───────────────────────────────────────────

describe("sendPushForEvent with context", () => {
	it("includes slug and sessionId from context in push payload", () => {
		const push = createMockPushManager();
		sendPushForEvent(push, { type: "done", code: 0 }, createSilentLogger(), {
			slug: "my-project",
			sessionId: "sess-123",
		});

		expect(push.sendToAll).toHaveBeenCalledWith({
			type: "done",
			title: "Task Complete",
			body: "Agent has finished processing.",
			tag: "opencode-done",
			slug: "my-project",
			sessionId: "sess-123",
		});
	});

	it("omits slug when not provided in context", () => {
		const push = createMockPushManager();
		sendPushForEvent(push, { type: "done", code: 0 }, createSilentLogger(), {
			sessionId: "sess-123",
		});

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior call
		const payload = push.sendToAll.mock.calls[0]![0];
		expect(payload).not.toHaveProperty("slug");
		expect(payload).toHaveProperty("sessionId", "sess-123");
	});

	it("omits sessionId when not provided in context", () => {
		const push = createMockPushManager();
		sendPushForEvent(push, { type: "done", code: 0 }, createSilentLogger(), {
			slug: "my-project",
		});

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior call
		const payload = push.sendToAll.mock.calls[0]![0];
		expect(payload).toHaveProperty("slug", "my-project");
		expect(payload).not.toHaveProperty("sessionId");
	});

	it("works without context parameter (backward compatible)", () => {
		const push = createMockPushManager();
		sendPushForEvent(push, { type: "done", code: 0 }, createSilentLogger());

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior call
		const payload = push.sendToAll.mock.calls[0]![0];
		expect(payload).toEqual({
			type: "done",
			title: "Task Complete",
			body: "Agent has finished processing.",
			tag: "opencode-done",
		});
		expect(payload).not.toHaveProperty("slug");
		expect(payload).not.toHaveProperty("sessionId");
	});
});

// ─── resolveNotifications with sessionId ─────────────────────────────────────

describe("resolveNotifications with sessionId", () => {
	it("includes sessionId in crossSessionPayload when route drops", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0 } as RelayMessage,
			{ action: "drop", reason: "no viewers" },
			false,
			"sess-456",
		);

		expect(result.broadcastCrossSession).toBe(true);
		expect(result.crossSessionPayload).toBeDefined();
		expect(result.crossSessionPayload?.sessionId).toBe("sess-456");
	});

	it("omits sessionId from crossSessionPayload when not provided", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0 } as RelayMessage,
			{ action: "drop", reason: "no viewers" },
			false,
		);

		expect(result.broadcastCrossSession).toBe(true);
		expect(result.crossSessionPayload).toBeDefined();
		expect(result.crossSessionPayload).not.toHaveProperty("sessionId");
	});

	it("does not include sessionId when route sends (no cross-session payload)", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0 } as RelayMessage,
			{ action: "send", sessionId: "s1" },
			false,
			"sess-789",
		);

		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(false);
		expect(result.crossSessionPayload).toBeUndefined();
	});
});
