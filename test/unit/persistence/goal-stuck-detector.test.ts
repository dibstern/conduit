import { describe, expect, it } from "vitest";
import {
	type Check,
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
	it("changed revisions and question sets separate otherwise similar blockers", () => {
		const revision =
			"Release review remains blocked for commit abc1234 while approval is missing.";
		expect(
			detectStuck(
				checks([
					revision,
					revision,
					revision,
					revision.replace("abc1234", "def5678"),
				]),
				product,
			).stuck,
		).toBeNull();
		const questions =
			"Release review remains blocked while answers to q1 and q2 are missing.";
		expect(
			detectStuck(
				checks([
					questions,
					questions,
					questions,
					questions.replace("q2", "q3"),
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
