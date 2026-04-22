import { describe, expect, it } from "vitest";
import { CANONICAL_EVENT_TYPES } from "../../../../src/lib/persistence/events.js";
import {
	CLAUDE_NOT_APPLICABLE,
	CLAUDE_PRODUCED,
} from "../../../../src/lib/provider/claude/event-type-guard.js";

describe("Claude event type guard", () => {
	it("covers every canonical event type", () => {
		const covered = new Set([...CLAUDE_PRODUCED, ...CLAUDE_NOT_APPLICABLE]);
		const missing = CANONICAL_EVENT_TYPES.filter((t) => !covered.has(t));
		expect(missing).toEqual([]);
	});

	it("has no overlap between produced and not-applicable", () => {
		const overlap = [...CLAUDE_PRODUCED].filter((t) =>
			CLAUDE_NOT_APPLICABLE.has(t),
		);
		expect(overlap).toEqual([]);
	});

	it("produced set includes thinking.end (regression)", () => {
		expect(CLAUDE_PRODUCED.has("thinking.end")).toBe(true);
	});
});
