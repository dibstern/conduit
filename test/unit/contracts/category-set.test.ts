// Failure modes: threshold drift, routine compared to weighted scores, retired
// options winning, absent probabilities, unstable ties, and marks drifting.
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CATEGORY_SET,
	surfacingLevel,
} from "../../../src/lib/contracts/category-set.js";

describe("surfacingLevel", () => {
	it.each([
		[0.7, "key"],
		[0.699, "balanced"],
		[0.4, "balanced"],
		[0.399, "all"],
	] as const)("maps Ask p=%s to %s", (ask, level) => {
		expect(
			surfacingLevel({ probabilities: { ask } }, DEFAULT_CATEGORY_SET),
		).toEqual({
			level,
			category: "ask",
		});
	});

	it("uses weighted prominence for the category, raw probabilities for routine", () => {
		expect(
			surfacingLevel(
				{ probabilities: { ask: 0.35, finding: 0.6, routine: 0.4 } },
				DEFAULT_CATEGORY_SET,
			),
		).toEqual({ level: "all", category: "ask" });
		expect(
			surfacingLevel(
				{ probabilities: { ask: 0.2, finding: 0.3, routine: 0.5 } },
				DEFAULT_CATEGORY_SET,
			),
		).toEqual({ level: "hidden", category: "ask" });
	});

	it("ignores retired and unknown categories and hides failed verdicts", () => {
		const set = {
			...DEFAULT_CATEGORY_SET,
			categories: DEFAULT_CATEGORY_SET.categories.map((category) => ({
				...category,
				retired: category.id === "ask",
			})),
		};
		expect(
			surfacingLevel({ probabilities: { ask: 1, deleted: 1, risk: 0.5 } }, set),
		).toEqual({ level: "balanced", category: "risk" });
		expect(surfacingLevel({ probabilities: null }, set)).toEqual({
			level: "hidden",
			category: null,
		});
		expect(surfacingLevel({ probabilities: { routine: 1 } }, set).level).toBe(
			"hidden",
		);
		expect(
			surfacingLevel({ probabilities: {} }, { ...set, categories: [] }),
		).toEqual({
			level: "hidden",
			category: null,
		});
	});

	it("keeps ties in set order and does not let routine win an equal probability", () => {
		expect(
			surfacingLevel(
				{ probabilities: { blocked: 0.5, risk: 0.5, routine: 0.5 } },
				DEFAULT_CATEGORY_SET,
			),
		).toEqual({ level: "balanced", category: "blocked" });
	});

	it("applies absolute marks, falling back to Jev for a deleted category", () => {
		const verdict = { probabilities: { ask: 0.8 } };
		expect(
			surfacingLevel(verdict, DEFAULT_CATEGORY_SET, { level: "all" }),
		).toEqual({
			level: "all",
			category: "ask",
		});
		expect(
			surfacingLevel(verdict, DEFAULT_CATEGORY_SET, {
				level: "balanced",
				category: "gone",
			}),
		).toEqual({ level: "balanced", category: "ask" });
		expect(
			surfacingLevel({ probabilities: null }, DEFAULT_CATEGORY_SET, {
				level: "key",
				category: "risk",
			}),
		).toEqual({ level: "key", category: "risk" });
	});
});
