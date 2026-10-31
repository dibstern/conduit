import { describe, expect, it } from "vitest";
import type { Mutation } from "./reference.js";
import { Driver, scenarios, sourceOnlyCases } from "./scenarios.js";

/** Scenarios a later lane builds: each must fail with that lane's typed not-yet-built rejection. */
const notBuilt: ReadonlyMap<string, string> = new Map([
	["RL-003", "32.2.8"],
	["RL-010", "32.2.8"],
	["RL-021", "32.2.6"],
	["RL-027", "32.2.8"],
	["RL-030", "32.2.8"],
	["RL-031", "32.2.6"],
	["RL-039", "32.2.7"],
	["RL-045", "32.2.11"],
	["RL-054", "32.2.8"],
	["RL-055", "32.2.6"],
	["RL-056", "32.2.8"],
	["RL-072", "32.2.8"],
	["RL-075", "32.2.8"],
	["RL-079", "32.2.7"],
	["RL-080", "32.2.7"],
	["RL-082", "32.2.7"],
	["RL-083", "32.2.7"],
	["RL-089", "32.2.7"],
	["RL-090", "32.2.7"],
	["R10-3", "32.2.8"],
	["R10-5", "32.2.6"],
	["L6-1", "32.2.11"],
	["L6-2", "32.2.11"],
	["L6-3", "32.2.11"],
]);

describe("[step1] Run Ledger catalogue scenarios", () => {
	for (const scenario of scenarios) {
		describe(`${scenario.title} (${scenario.id})`, () => {
			it("reference", () => scenario.run(new Driver(scenario.provider)));
			const ticket = notBuilt.get(scenario.id);
			if (ticket === undefined)
				it("decider", () =>
					scenario.run(new Driver(scenario.provider, "decider")));
			else
				it(`decider [not yet built (${ticket})]`, () =>
					expect(() =>
						scenario.run(new Driver(scenario.provider, "decider")),
					).toThrow(`not yet built (${ticket})`));
		});
	}

	for (const scenario of sourceOnlyCases) {
		it.todo(`${scenario.title} (${scenario.id}). ${scenario.reason}`);
	}
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
