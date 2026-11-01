import { it } from "vitest";

// Remove an entry when its implementation lands; an unexpected pass fails the suite.
export const pendingCases: ReadonlyMap<string, string> = new Map([
	// 32.2.3/32.2.4 convergence: each entry is a live test the oracle and the fake still disagree on, keyed by
	// the first check it fails. The contract is frozen at 7732bd85 and decides neither gap below, so the
	// wrong side is undecided and these stay pended until a contract round names it.
	...(
		[
			[
				"LI8, CONTRACT.md 978-997 (gap, 3.9: a steer main dispatches into an open Run mints its own run.requested; whether it joins that Run, so main's terminal for the open Run ends it, is undecided, 984. Wrong side undecided: the oracle lets the open Run's terminal end the steer's work, the fake keeps its native send unfinished)",
				[
					"claude oracle traces, seed 82103302",
					"codex oracle traces, seed 82103302",
					"cursor oracle traces, seed 82103202",
					"cursor oracle traces, seed 82103302",
					"review trace R1-1",
				],
			],
			[
				"LI8, CONTRACT.md 871-876 against 3086-3089 (gap, GAP 5 against section 9: when OpenCode work ends. GAP 5 ends a main-run Run once main's terminal folds; section 9 keeps the native fence until a covering idle probe. Wrong side undecided: the oracle hides an unfinished native send, the fake keeps it)",
				[
					"opencode oracle traces, seed 82103200",
					"opencode oracle traces, seed 82103203",
					"opencode oracle traces, seed 82103300",
					"opencode oracle traces, seed 82103302",
					"review trace R1-2",
					"review trace R1-3",
					"review trace R1-4",
					"review trace R2-1",
					"review trace R2-2",
				],
			],
			[
				"D50, CONTRACT.md 871-876 against 3086-3089 and 3.6 692-698 (the same GAP 5 against section 9 gap: the retirement leaves a reached OpenCode Run unended while its native fence holds. Wrong side undecided)",
				[
					"opencode oracle traces, seed 82103202",
					"opencode oracle traces, seed 82103301",
				],
			],
			[
				"coverage, CONTRACT.md 3456-3477 (11.2: fc.check stops at the first failing trace, so the OpenCode and steer seeds above cut generation short before these shapes. Wrong side: neither, the shapes wait on the seeds above)",
				[
					"confirm copied before a query replacement",
					"not_sent start ended its Run",
					"unheld_outcome after a reissue",
					"unlaunch by retryable",
					"joined Run's not_sent start retried in its execution",
					"Q28 journal settle",
				].map((shape) => `generated traces reach ${shape}`),
			],
		] as const
	).flatMap(([disagreement, names]) =>
		names.map((name): [string, string] => [
			`[convergence] ${name}`,
			`32.2.3/32.2.4: oracle and fake disagree on ${disagreement}`,
		]),
	),
]);

/** A suite's decider tests stay red until its core lands. */
export function pendingSuite(name: string): typeof it.fails {
	return pendingCases.has(name) ? it.fails : it;
}
