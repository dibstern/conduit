import { describe, expect, it } from "vitest";
import { CANONICAL_EVENT_TYPES } from "../../../src/lib/persistence/events.js";

describe("relay-event-sink translateCanonicalEvent exhaustiveness", () => {
	// These are the event types handled in the switch statement.
	// Keep this list in sync with translateCanonicalEvent().
	const HANDLED_TYPES = new Set([
		"text.delta",
		"thinking.start",
		"thinking.delta",
		"thinking.end",
		"tool.started",
		"tool.running",
		"tool.input_updated",
		"tool.completed",
		"turn.completed",
		"turn.error",
		"turn.interrupted",
		"session.status",
		"message.created",
		"session.created",
		"session.renamed",
		"session.provider_changed",
		"permission.asked",
		"permission.resolved",
		"question.asked",
		"question.resolved",
	]);

	it("handles every canonical event type", () => {
		const missing = CANONICAL_EVENT_TYPES.filter((t) => !HANDLED_TYPES.has(t));
		expect(missing).toEqual([]);
	});

	it("HANDLED_TYPES does not contain stale entries", () => {
		const stale = [...HANDLED_TYPES].filter(
			(t) =>
				!CANONICAL_EVENT_TYPES.includes(
					t as (typeof CANONICAL_EVENT_TYPES)[number],
				),
		);
		expect(stale).toEqual([]);
	});
});
