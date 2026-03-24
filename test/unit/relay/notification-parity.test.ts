// ─── Notification Parity Contract Test ───────────────────────────────────────
// Validates that resolveNotifications() produces correct results for all key
// notification scenarios. Acts as a contract that both SSE wiring and message
// poller paths rely on for consistent notification behavior.

import { describe, expect, it } from "vitest";
import type { RouteDecision } from "../../../src/lib/relay/event-pipeline.js";
import { resolveNotifications } from "../../../src/lib/relay/notification-policy.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const routeSend = (sessionId: string): RouteDecision => ({
	action: "send",
	sessionId,
});
const routeDrop = (reason: string): RouteDecision => ({
	action: "drop",
	reason,
});

// ─── Parity Scenarios ────────────────────────────────────────────────────────

describe("notification parity contract", () => {
	it("root done with viewers → push yes, cross-session no", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0 } as RelayMessage,
			routeSend("s1"),
			false, // not subagent
			"s1",
		);
		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(false);
		expect(result.crossSessionPayload).toBeUndefined();
	});

	it("root done without viewers → push yes, cross-session yes with payload", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0 } as RelayMessage,
			routeDrop("no viewers for session s1"),
			false,
			"s1",
		);
		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(true);
		expect(result.crossSessionPayload).toEqual({
			type: "notification_event",
			eventType: "done",
			sessionId: "s1",
		});
	});

	it("root error without viewers → push yes, cross-session yes with error message", () => {
		const result = resolveNotifications(
			{
				type: "error",
				code: "FATAL",
				message: "Something broke",
			} as RelayMessage,
			routeDrop("no viewers"),
			false,
			"s1",
		);
		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(true);
		expect(result.crossSessionPayload).toEqual({
			type: "notification_event",
			eventType: "error",
			message: "Something broke",
			sessionId: "s1",
		});
	});

	it("subagent done → completely suppressed (no push, no cross-session)", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0 } as RelayMessage,
			routeDrop("no viewers"),
			true, // is subagent
			"sub-1",
		);
		expect(result.sendPush).toBe(false);
		expect(result.broadcastCrossSession).toBe(false);
		expect(result.crossSessionPayload).toBeUndefined();
	});

	it("subagent error → NOT suppressed (errors always notify)", () => {
		const result = resolveNotifications(
			{
				type: "error",
				code: "ERR",
				message: "subagent failed",
			} as RelayMessage,
			routeDrop("no viewers"),
			true, // is subagent
			"sub-1",
		);
		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(true);
		expect(result.crossSessionPayload).toMatchObject({
			type: "notification_event",
			eventType: "error",
			message: "subagent failed",
			sessionId: "sub-1",
		});
	});

	it("non-notifiable delta → no push, no cross-session", () => {
		const result = resolveNotifications(
			{ type: "delta", text: "hello" } as RelayMessage,
			routeSend("s1"),
			false,
			"s1",
		);
		expect(result.sendPush).toBe(false);
		expect(result.broadcastCrossSession).toBe(false);
		expect(result.crossSessionPayload).toBeUndefined();
	});

	it("error with viewers (route send) → push yes, cross-session no", () => {
		const result = resolveNotifications(
			{
				type: "error",
				code: "ERR",
				message: "oops",
			} as RelayMessage,
			routeSend("s1"),
			false,
			"s1",
		);
		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(false);
		expect(result.crossSessionPayload).toBeUndefined();
	});

	it("non-notifiable tool_result → no push, no cross-session", () => {
		const result = resolveNotifications(
			{
				type: "tool_result",
				id: "t1",
				content: "output",
				is_error: false,
			} as RelayMessage,
			routeDrop("no viewers"),
			false,
			"s1",
		);
		expect(result.sendPush).toBe(false);
		expect(result.broadcastCrossSession).toBe(false);
	});
});
