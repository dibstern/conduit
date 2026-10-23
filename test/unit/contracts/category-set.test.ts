// Failure modes: threshold drift, routine compared to weighted scores, retired
// options winning, absent probabilities, unstable ties, and marks drifting.
import { describe, expect, it } from "vitest";
import {
	countSessionCategories,
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

// Failure modes: hidden or uncategorised messages count; marks are ignored;
// retirement destroys a verdict or restores other retired categories too.
describe("countSessionCategories", () => {
	const set = {
		categories: DEFAULT_CATEGORY_SET.categories.filter(({ id }) =>
			["ask", "risk", "finding"].includes(id),
		),
	};

	it("counts visible categories at every level and applies absolute marks", () => {
		expect(
			countSessionCategories(
				[
					{ probabilities: { ask: 0.8 } },
					{ probabilities: { ask: 0.5 } },
					{ probabilities: { finding: 0.5 } },
					{ probabilities: { ask: 0.5, routine: 0.9 } },
					{ probabilities: { ask: 1 }, mark: { level: "hidden" } },
					{
						probabilities: { ask: 1 },
						mark: { level: "balanced", category: "risk" },
					},
					{
						probabilities: null,
						mark: { level: "key", category: "risk" },
					},
					{ probabilities: null, mark: { level: "key" } },
					{ probabilities: { deleted: 1 } },
				],
				set,
			),
		).toEqual({ ask: 2, risk: 2, finding: 1 });
	});

	it("includes zero rows, including an empty session and empty category set", () => {
		expect(countSessionCategories([], set)).toEqual({
			ask: 0,
			risk: 0,
			finding: 0,
		});
		expect(
			countSessionCategories([{ probabilities: { ask: 1 } }], {
				categories: [],
			}),
		).toEqual({});
	});

	it("redistributes or hides retired verdicts and exactly restores their counts", () => {
		const verdicts = [
			{ probabilities: { ask: 0.8, finding: 0.7 } },
			{ probabilities: { ask: 0.8, routine: 0.5 } },
			{ probabilities: { finding: 0.9 } },
		];
		const original = countSessionCategories(verdicts, set);
		const retired = {
			categories: set.categories.map((category) => ({
				...category,
				retired: category.id === "ask",
			})),
		};
		expect(original).toEqual({ ask: 2, risk: 0, finding: 1 });
		expect(countSessionCategories(verdicts, retired)).toEqual({
			ask: 2,
			risk: 0,
			finding: 2,
		});
		expect(
			countSessionCategories(verdicts, {
				categories: retired.categories.map((category) => ({
					...category,
					retired: false,
				})),
			}),
		).toEqual(original);
	});

	it("scores each retired category with only itself restored, retaining marks", () => {
		const retired = {
			categories: set.categories.map((category) => ({
				...category,
				retired: category.id !== "finding",
			})),
		};
		expect(
			countSessionCategories(
				[
					{ probabilities: { ask: 0.9, risk: 0.8, finding: 0.7 } },
					{
						probabilities: { finding: 1 },
						mark: { level: "key", category: "ask" },
					},
				],
				retired,
			),
		).toEqual({ ask: 2, risk: 1, finding: 1 });
	});
});
