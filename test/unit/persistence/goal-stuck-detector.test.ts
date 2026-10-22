import { describe, expect, it } from "vitest";
import {
	type Check,
	detectGoalStuck,
	detectStuck,
} from "../../../src/lib/persistence/goal-stuck-detector.js";

const reasons = [
	"Release remains blocked because the synthetic review approval is missing.",
	"The release is blocked because the synthetic review approval remains missing.",
	"Synthetic review approval is missing, so the release remains blocked.",
	"The synthetic review approval remains missing and blocks the release.",
];
const checks = (values: readonly (string | null)[]): Check[] =>
	values.map((reason, index) => ({
		iteration: index + 1,
		at: (index + 1) * 100,
		reason,
	}));
const product = { minChecks: 3 };

describe("goal stuck detector", () => {
	it("recognises synthetic blockers despite drifting wording", () => {
		const result = detectStuck(checks(reasons), product);
		expect(result.stuck).toMatchObject({
			since: 100,
			sinceIteration: 1,
			count: 4,
		});
		expect(reasons).toContain(result.stuck?.blocker);
	});
	it("waits for three consecutive checks at the product threshold", () => {
		expect(detectStuck(checks(reasons.slice(0, 2)), product).stuck).toBeNull();
		expect(detectStuck(checks(reasons.slice(0, 3)), product).stuck?.count).toBe(
			3,
		);
	});
	it("a progress check ends the current stuck run", () => {
		const result = detectStuck(
			checks([
				...reasons,
				"Database migration completed successfully; preparing the documentation preview.",
			]),
			product,
		);
		expect(result.stuck).toBeNull();
		expect(result.runs).toHaveLength(1);
		expect(result.verdicts.at(-1)).toEqual({
			iteration: 5,
			stuck: false,
			blockerId: null,
		});
	});
	it("keeps run ids stable as a blocker continues", () => {
		expect(detectStuck(checks(reasons.slice(0, 3)), product).runs[0]?.id).toBe(
			"1@100",
		);
		expect(detectStuck(checks(reasons), product).runs[0]?.id).toBe("1@100");
	});
	it("does not change earlier verdicts when later checks arrive", () => {
		const history = checks([
			...reasons,
			"Documentation preview is published; waiting for the deployment token.",
			...reasons,
		]);
		const final = detectStuck(history, product);
		for (let length = 1; length <= history.length; length++) {
			expect(detectStuck(history.slice(0, length), product).verdicts).toEqual(
				final.verdicts.slice(0, length),
			);
		}
	});
	it("missing reasons and iteration gaps end a run", () => {
		expect(detectStuck(checks([...reasons, null]), product).stuck).toBeNull();
		expect(
			detectStuck(
				[
					...checks(reasons),
					{ iteration: 6, at: 600, reason: reasons[0] ?? null },
				],
				product,
			).stuck,
		).toBeNull();
	});
	it.each([
		["path", "samples/alpha.csv", "samples/beta.csv"],
		["hash", "abc1234", "def5678"],
		["version", "v1.2.3", "v2.3.4"],
		["mixed id", "Batch7", "Batch8"],
	])("a new %s starts new work in otherwise similar reasons", (_kind, first, next) => {
		const reason = `The synthetic measurement review remains blocked for ${first} while approval is missing.`;
		const history = checks([
			reason,
			reason,
			reason,
			reason.replace(first, next),
		]);
		expect(detectStuck(history, product).stuck).toBeNull();
		expect(
			detectStuck(history, { ...product, contextGuards: false }).stuck?.count,
		).toBe(4);
	});
	it.each([
		["clock", "09:30", "10:45"],
		["date", "2026-01-02", "2026-02-03"],
		["count", "12 samples", "24 samples"],
		["duration", "15 minutes", "30 minutes"],
		["size", "128 MB", "256 MB"],
	])("changing a %s never supplies identity", (_kind, first, next) => {
		const reason = `Synthetic measurement review remains blocked while approval is missing after ${first}.`;
		expect(
			detectStuck(
				checks([reason, reason, reason, reason.replace(first, next)]),
				product,
			).stuck?.count,
		).toBe(4);
	});
	it("generic identifier families detect removal-only changes", () => {
		const reason =
			"Synthetic measurement review remains blocked while samples B1-B3 await approval.";
		expect(
			detectStuck(
				checks([reason, reason, reason, reason.replace("B1-B3", "B1-B2")]),
				product,
			).stuck,
		).toBeNull();
	});
	it("generic subject polarity changes split otherwise similar evidence", () => {
		const reason =
			"The synthetic measurement review remains blocked. Calibration is ready.";
		expect(
			detectStuck(
				checks([
					reason,
					reason,
					reason,
					reason.replace("is ready", "is not ready"),
				]),
				product,
			).stuck,
		).toBeNull();
	});
	it("rejects invalid check ordering and detector options", () => {
		expect(() =>
			detectStuck([
				{ iteration: 2, at: 200, reason: "blocked" },
				{ iteration: 1, at: 100, reason: "blocked" },
			]),
		).toThrow(RangeError);
		expect(() => detectStuck([], { minChecks: 1 })).toThrow(RangeError);
	});
});

describe("goal detection boundary", () => {
	it.each([
		["duplicate", [1, 2, 3, 3]],
		["unordered", [1, 3, 2, 4]],
	])("%s iterations discard all runs and keep per-check verdicts", (_kind, iterations) => {
		const history = checks(reasons).map((check, index) => ({
			...check,
			iteration: iterations[index] ?? 0,
		}));
		expect(() => detectStuck(history, product)).toThrow(RangeError);
		expect(detectGoalStuck(history)).toEqual({
			stuck: null,
			runs: [],
			verdicts: history.map(({ iteration }) => ({
				iteration,
				stuck: false,
				blockerId: null,
			})),
		});
	});
	it("caps a 50 KB parser-heavy reason cheaply without mutating raw evidence", () => {
		const reason = "item is ready ".repeat(4_000).slice(0, 51_200);
		const history = checks([reason, reason, reason]);
		const cpuStart = process.cpuUsage();
		const result = detectGoalStuck(history);
		const cpu = process.cpuUsage(cpuStart);
		expect((cpu.user + cpu.system) / 1_000).toBeLessThan(100);
		expect(result).toEqual(
			detectStuck(
				history.map((check) => ({ ...check, reason: reason.slice(0, 4_096) })),
				product,
			),
		);
		expect(result.stuck?.blocker).toHaveLength(4_096);
		expect(history[0]?.reason).toHaveLength(51_200);
	});
	it("normalizes backwards clocks in iteration order and retains caller timestamps", () => {
		const history = checks(reasons).map((check, index) => ({
			...check,
			at: 400 - index * 100,
		}));
		expect(detectGoalStuck(history)).toEqual(
			detectStuck(
				history.map((check) => ({ ...check, at: 400 })),
				product,
			),
		);
		expect(history.map((check) => check.at)).toEqual([400, 300, 200, 100]);
	});
	it("uses the production threshold and waits for three checks", () => {
		expect(detectGoalStuck(checks(reasons.slice(0, 2))).stuck).toBeNull();
		expect(detectGoalStuck(checks(reasons))).toEqual(
			detectStuck(checks(reasons), { minChecks: 3, threshold: 0.55 }),
		);
	});
});
