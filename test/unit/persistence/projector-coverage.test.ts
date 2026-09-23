// ─── Projector Coverage ─────────────────────────────────────────────────────
// A canonical event type that no projector claims is dispatched to nothing:
// no write, no error, no log line, and the cursor advances anyway. That is how
// session.compaction stayed unprojected for three months behind a green suite.
// This test is the tripwire — add an event type without a handler, or without
// an explicit entry saying it is deliberately dropped, and it goes red.

import { describe, expect, it } from "vitest";
import {
	createAllEffectProjectors,
	UNPROJECTED_CANONICAL_EVENT_TYPES,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import { CANONICAL_EVENT_TYPES } from "../../../src/lib/persistence/events.js";

const claimed = new Set<string>(
	createAllEffectProjectors().flatMap((p) => [...p.handles]),
);
const canonical: readonly string[] = CANONICAL_EVENT_TYPES;

describe("projector coverage over canonical event types", () => {
	it("claims or explicitly ignores every canonical event type", () => {
		const uncovered = canonical.filter(
			(type) =>
				!claimed.has(type) && !UNPROJECTED_CANONICAL_EVENT_TYPES.includes(type),
		);
		expect(uncovered).toEqual([]);
	});

	it("keeps the ignore list honest", () => {
		// An entry that is both handled and listed as ignored, or that names a type
		// no longer in the vocabulary, is stale documentation of a real dispatch.
		for (const type of UNPROJECTED_CANONICAL_EVENT_TYPES) {
			expect(canonical).toContain(type);
			expect(claimed.has(type)).toBe(false);
		}
	});

	it("dispatches no projector to an ignored type", () => {
		for (const projector of createAllEffectProjectors()) {
			for (const type of projector.handles) {
				expect(UNPROJECTED_CANONICAL_EVENT_TYPES).not.toContain(type);
			}
		}
	});
});
