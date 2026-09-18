import { describe, expect, it } from "vitest";
import { resolveNotifications } from "../../../src/lib/relay/notification-policy.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

describe("resolveNotifications", () => {
	it("does not alert from anonymous status hints", () => {
		expect(
			resolveNotifications(
				{ type: "done", code: 0, sessionId: "s1" },
				{ action: "drop", reason: "no viewers" },
				false,
			),
		).toEqual({ sendPush: false, broadcastCrossSession: false });
	});
	it("preserves originating identity in cross-session delivery", () => {
		expect(
			resolveNotifications(
				{ type: "done", code: 0, sessionId: "s1", alertId: "origin-T1" },
				{ action: "drop", reason: "no viewers" },
				false,
				"s1",
			).crossSessionPayload,
		).toEqual({
			type: "notification_event",
			eventType: "done",
			sessionId: "s1",
			alertId: "origin-T1",
		});
	});
	it("done + not subagent + route send → push yes, broadcast no", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0, alertId: "done-1" } as RelayMessage,
			{ action: "send", sessionId: "s1" },
			false,
		);
		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(false);
	});

	it("done + not subagent + route drop → push yes, broadcast yes", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0, alertId: "done-1" } as RelayMessage,
			{ action: "drop", reason: "no viewers" },
			false,
		);
		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(true);
		expect(result.crossSessionPayload).toBeDefined();
	});

	it("done + subagent → push no, broadcast no", () => {
		const result = resolveNotifications(
			{ type: "done", code: 0, alertId: "done-1" } as RelayMessage,
			{ action: "drop", reason: "no viewers" },
			true,
		);
		expect(result.sendPush).toBe(false);
		expect(result.broadcastCrossSession).toBe(false);
	});

	it("error + subagent → push yes (only done suppressed for subagents)", () => {
		const result = resolveNotifications(
			{
				type: "error",
				code: "ERR",
				alertId: "error-1",
				message: "something broke",
			} as RelayMessage,
			{ action: "drop", reason: "no viewers" },
			true,
		);
		expect(result.sendPush).toBe(true);
		expect(result.broadcastCrossSession).toBe(true);
	});

	it("error + not subagent + route drop → includes error message in payload", () => {
		const result = resolveNotifications(
			{
				type: "error",
				code: "ERR",
				alertId: "error-1",
				message: "something broke",
			} as RelayMessage,
			{ action: "drop", reason: "no viewers" },
			false,
		);
		expect(result.broadcastCrossSession).toBe(true);
		expect(result.crossSessionPayload).toHaveProperty(
			"message",
			"something broke",
		);
	});

	it("non-notifiable type (delta) → push no, broadcast no", () => {
		const result = resolveNotifications(
			{ type: "delta", text: "hello" } as RelayMessage,
			{ action: "send", sessionId: "s1" },
			false,
		);
		expect(result.sendPush).toBe(false);
		expect(result.broadcastCrossSession).toBe(false);
	});
});
