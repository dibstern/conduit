import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	CanonicalEvents,
	type LiveEventType,
} from "../../../src/lib/contracts/stored-event.js";
import {
	CANONICAL_EVENT_TYPES,
	canonicalEvent,
	EventId,
} from "../../../src/lib/persistence/events.js";
import { turnEndedAlert } from "../../../src/lib/relay/turn-ended-alert.js";

describe("turn-ended alert", () => {
	it.each([
		{
			type: "turn.completed",
			code: 0,
			alertId: '["s1","m1","done"]',
		},
		{
			type: "turn.error",
			code: 1,
			error: "failed",
			alertId: '["s1","m1","error","failed"]',
		},
		{
			type: "turn.interrupted",
			code: 1,
			alertId: '["s1","m1","done"]',
		},
	] as const)("preserves $type notification identity and exit code", (expected) => {
		const event = canonicalEvent(expected.type, "s1", {
			messageId: "m1",
			error: "failed",
		});
		expect(turnEndedAlert(event)).toEqual({
			type: "done",
			sessionId: "s1",
			code: expected.code,
			alertId: expected.alertId,
			...(expected.type === "turn.error" ? { error: expected.error } : {}),
		});
	});

	it.each([
		"turn.completed",
		"turn.error",
		"turn.interrupted",
	] as const)("uses the event ID when %s has no message ID", (type) => {
		const event = canonicalEvent(
			type,
			"s1",
			{ messageId: "", error: "failed" },
			{ eventId: Schema.decodeSync(EventId)("evt_terminal") },
		);
		expect(turnEndedAlert(event)).toMatchObject({
			alertId:
				type === "turn.error"
					? '["s1","evt_terminal","error","failed"]'
					: '["s1","evt_terminal","done"]',
		});
	});

	it.each(
		CANONICAL_EVENT_TYPES.filter(
			(type): type is LiveEventType =>
				CanonicalEvents[type].status === "live" &&
				type !== "turn.completed" &&
				type !== "turn.error" &&
				type !== "turn.interrupted",
		),
	)("does not alert for %s", (type) => {
		// Terminal-looking data must not alert unless the event type ends a turn.
		const event = canonicalEvent(type, "s1", {
			messageId: "m1",
			error: "failed",
		});
		expect(turnEndedAlert(event)).toBeUndefined();
	});
});
