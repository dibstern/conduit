import { describe, expect, it } from "vitest";
import { TraceDriver } from "./harness.js";
import { pendingSuite } from "./pending.js";
import type { Mutation } from "./reference.js";
import { reviewTraces } from "./review-traces.js";
import {
	begin,
	Driver,
	join,
	main,
	request,
	running,
	scenarios,
	sourceOnlyCases,
	stop,
	terminal,
} from "./scenarios.js";

/** Scenarios a later lane builds: each must fail with that lane's typed not-yet-built rejection. */
const notBuilt: ReadonlyMap<string, string> = new Map();

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

// CONTRACT.md 1864-1869 (4.8), 1521-1524 (4.3), 973-977 (3.9): from 32.5 a joined steer has its own
// transmissions and its own cap; a try that ends its own run before it starts fails or retries the
// steer only. How it could fail: the steer's run is mapped to its owner's Run, so a failed try's
// turn.error, or the cap's, ends that Run; or the dead run stays open and Stop still names it.
describe("[32.5] a steer's own unstarted run ending leaves its owner's Run", () => {
	for (const provider of ["claude", "cursor"] as const)
		for (const mode of ["reference", "decider"] as const)
			it(`${provider} ${mode}`, () => {
				const d = new Driver(provider, mode);
				const a = running(d);
				const first = begin(d, "B", "steer");
				join(d, a.runId, "B", first.runId);
				// A fresh-run retry's failed try, then the cap's error on the retry.
				terminal(d, first.runId, "error");
				const retry = request(d, "B");
				main(d, {
					kind: "run_terminal",
					runId: retry.runId,
					outcome: "error",
					code: "provider_send_attempts_exhausted",
				});
				expect(d.ended).toEqual([]);
				expect(d.view().active).toMatchObject({ runId: a.runId });
				stop(d);
				expect(d.latest("interrupt").effect).toMatchObject({
					runId: a.runId,
					runIds: [a.runId],
				});
				expect(terminal(d, a.runId, "interrupted").ended).toMatchObject([
					{ runId: a.runId },
				]);
			});
});
