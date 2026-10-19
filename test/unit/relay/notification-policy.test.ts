import { describe, expect, it } from "vitest";
import { resolveNotifications } from "../../../src/lib/relay/notification-policy.js";

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
			).alert,
		).toEqual({
			_tag: "alert",
			kind: "done",
			sessionId: "s1",
			alertId: "origin-T1",
		});
	});
	it("broadcasts an anonymous poller completion only when given an in-app identity", () => {
		expect(
			resolveNotifications(
				{ type: "done", code: 0, sessionId: "s1" },
				{ action: "drop", reason: "no viewers" },
				false,
				"s1",
				"poller-transition-1",
			),
		).toEqual({
			sendPush: false,
			broadcastCrossSession: true,
			alert: {
				_tag: "alert",
				kind: "done",
				sessionId: "s1",
				alertId: "poller-transition-1",
			},
		});
	});
});
