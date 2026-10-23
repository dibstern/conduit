import { describe, expect, it } from "vitest";
import { TraceDriver } from "./harness.js";
import { oracleTest } from "./pending.js";
import { scenarios, sourceOnlyCases } from "./scenarios.js";

describe("[step1] Run Ledger catalogue scenarios", () => {
	for (const scenario of scenarios) {
		describe(`${scenario.title} (${scenario.id})`, () => {
			const check = oracleTest(
				`[step1] Run Ledger catalogue scenarios ${scenario.title} (${scenario.id})`,
			);
			check(`${scenario.title} reference`, () => {
				scenario.run(new TraceDriver(scenario.provider, "reference"));
			});

			check(`${scenario.title} decider`, () => {
				scenario.run(new TraceDriver(scenario.provider, "decider"));
			});
		});
	}

	for (const scenario of sourceOnlyCases) {
		it.todo(`${scenario.title} (${scenario.id}). ${scenario.reason}`);
	}
});

describe("[step1] reference mutation sensitivity", () => {
	for (const [id, mutation] of [
		["RL-041", "ignore_pause"],
		["RL-055", "resend_unknown"],
		["R10-5", "extend_settle"],
	] as const) {
		it(`[step1] ${id} detects ${mutation}`, () => {
			const scenario = scenarios.find((entry) => entry.id === id);
			expect(scenario).toBeDefined();
			if (!scenario) return;
			expect(() =>
				scenario.run(new TraceDriver(scenario.provider, "reference", mutation)),
			).toThrow();
		});
	}
});
