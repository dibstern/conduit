import { describe, expect, it } from "vitest";
import {
	type Check,
	createGoalStuckTracker,
	detectGoalStuck,
} from "../../../src/lib/persistence/goal-stuck-detector.js";

const blocked =
	"The synthetic release is blocked because review approval is missing.";
const changed =
	"Database migration completed; preparing documentation preview.";

// Failure modes: losing the original run start/count, centroid drift, identifier
// context surviving inferred boundaries, missing evidence/gaps, clock rollback,
// and an invalid imported prefix becoming plausible after later valid checks.
describe("incremental goal stuck header", () => {
	it.each([
		["long run", Array<string | null>(2500).fill(blocked)],
		[
			"progress and missing evidence",
			[
				blocked,
				blocked,
				blocked,
				changed,
				null,
				"",
				"the and",
				blocked,
				blocked,
				blocked,
			],
		],
		[
			"identifiers and reuse",
			[
				"Batch7",
				"Batch7",
				"Batch7",
				"Batch8",
				"Batch8",
				"Batch8",
				"Batch7",
				"Batch7",
				"Batch7",
			].map((id) => `${blocked} ${id}`),
		],
		[
			"family removals",
			["B1-B3", "B1-B3", "B1-B3", "B1-B2", "B1-B2", "B1-B2"].map(
				(id) => `${blocked} ${id}`,
			),
		],
		[
			"polarity",
			["ready", "ready", "ready", "not ready", "not ready", "not ready"].map(
				(state) => `${blocked} Calibration is ${state}.`,
			),
		],
		[
			"gradual drift",
			Array.from(
				{ length: 120 },
				(_, i) =>
					`${i < 60 ? blocked : changed} ${i % 3 ? "The review board requires approval." : "Publication awaits review."}`,
			),
		],
		[
			"oversized evidence",
			Array<string | null>(4).fill("item is ready ".repeat(4000)),
		],
	] as const)("matches full-history prefixes: %s", (_name, reasons) => {
		const tracker = createGoalStuckTracker();
		const history: Check[] = [];
		for (const [index, reason] of reasons.entries()) {
			const check = { iteration: index + 1, at: 100 + index, reason };
			history.push(check);
			const actual = tracker.add(check);
			if (
				reasons.length > 120 &&
				index > 8 &&
				index % 101 !== 0 &&
				index !== reasons.length - 1
			)
				continue;
			const { stuck } = detectGoalStuck(history);
			expect(actual).toEqual(
				stuck
					? {
							since: history.find(
								(item) => item.iteration === stuck.sinceIteration,
							)?.at,
							lastAt: check.at,
							count: stuck.count,
						}
					: null,
			);
		}
	});

	it.each([
		["iteration gaps", [1, 2, 3, 5, 6, 7]],
		["duplicate imported iteration", [1, 2, 3, 3, 4, 5, 6]],
		["unordered imported iteration", [1, 3, 2, 4, 5, 6]],
		["invalid imported iteration", [1, 2, 3, 3.5, 4, 5, 6]],
	] as const)("matches full history through %s and backwards clocks", (_name, iterations) => {
		const tracker = createGoalStuckTracker();
		const history: Check[] = [];
		for (const [index, iteration] of iterations.entries()) {
			const check = { iteration, at: 400 - index * 100, reason: blocked };
			history.push(check);
			const { stuck } = detectGoalStuck(history);
			expect(tracker.add(check)).toEqual(
				stuck
					? {
							since: history.find(
								(item) => item.iteration === stuck.sinceIteration,
							)?.at,
							lastAt: check.at,
							count: stuck.count,
						}
					: null,
			);
		}
	});
});
