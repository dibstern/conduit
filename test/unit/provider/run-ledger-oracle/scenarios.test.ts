import { describe, expect, it } from "vitest";
import { TraceDriver } from "./harness.js";
import { pendingSuite } from "./pending.js";
import type { Mutation } from "./reference.js";
import { reviewTraces } from "./review-traces.js";
import { Driver, scenarios, sourceOnlyCases } from "./scenarios.js";

describe("[step1] Run Ledger catalogue scenarios", () => {
	for (const scenario of scenarios) {
		describe(`${scenario.title} (${scenario.id})`, () => {
			it("reference", () => scenario.run(new Driver(scenario.provider)));
			pendingSuite("[checkpoint] run-ledger-oracle-scenarios")("decider", () =>
				scenario.run(new Driver(scenario.provider, "decider")),
			);
		});
	}

	for (const scenario of sourceOnlyCases) {
		it.todo(`${scenario.title} (${scenario.id}). ${scenario.reason}`);
	}
});

// Review traces run on the fake's TraceDriver, so every step also meets the fake's ground truth.
describe("Run Ledger review traces", () => {
	for (const trace of reviewTraces)
		pendingSuite(`[convergence] review trace ${trace.id}`)(
			`${trace.title} (${trace.id})`,
			() => trace.run(new TraceDriver(trace.provider)),
		);
});

describe("[step1] reference mutation sensitivity", () => {
	for (const [id, mutation] of [
		["RL-021", "probe_at_outcome"],
		["RL-055", "probe_at_outcome"],
		["11A-1", "extend_settle"],
		["L6-1", "unforced_alarm"],
	] satisfies [string, Mutation][]) {
		it(`[step1] ${id} detects ${mutation}`, () => {
			const scenario = scenarios.find((entry) => entry.id === id);
			expect(scenario).toBeDefined();
			if (scenario === undefined) return;
			expect(() =>
				scenario.run(new Driver(scenario.provider, "reference", mutation)),
			).toThrow();
		});
	}
});
