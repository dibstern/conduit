import { it } from "vitest";

// Remove an entry when its implementation lands; an unexpected pass fails the suite.
export const pendingCases: ReadonlyMap<string, string> = new Map([
	[
		"[checkpoint] run-ledger-oracle-scenarios",
		"32.2.5 onward: the decider stub rejects every command",
	],
	[
		"[checkpoint] run-ledger-decider",
		"32.2.5 onward: the decider stub rejects every command",
	],
	[
		"[checkpoint] run-ledger-differential",
		"32.2.5 onward: public core differential",
	],
	// 32.2.3/32.2.4 convergence: each entry is a live test the oracle and the fake still disagree on,
	// keyed by the first check it fails. Generated D34 coverage and the race gate stop with the failing
	// traces, so they reach no shape until the traces converge.
	...(
		[
			[
				"LI5 (L2 case 2: an end_session for a Run with an execution carries null, not its runner's label; or L5: a scope end records no lost work)",
				[
					"claude oracle traces, seed 82103201",
					"claude oracle traces, seed 82103302",
					"codex oracle traces, seed 82103201",
					"codex oracle traces, seed 82103302",
					"codex oracle traces, seed 82103200",
				],
			],
			[
				"LI7 (older-label evidence changes session liveness)",
				[
					"claude oracle traces, seed 82103200",
					"claude oracle traces, seed 82103300",
				],
			],
			[
				"LI8 (an unfinished native send or a running turn hidden by anythingMayAct)",
				[
					"claude oracle traces, seed 82103202",
					"codex oracle traces, seed 82103202",
					"cursor oracle traces, seed 82103200",
					"cursor oracle traces, seed 82103202",
					"cursor oracle traces, seed 82103303",
					"opencode oracle traces, seed 82103200",
					"opencode oracle traces, seed 82103203",
					"opencode oracle traces, seed 82103302",
				],
			],
			[
				"D50 (a retirement, Stop or Run now leaves a reached or not-yet-delivered main run unended, or ends it process_lost instead of unlaunching it, 3.6)",
				[
					"claude oracle traces, seed 82103203",
					"claude oracle traces, seed 82103301",
					"claude oracle traces, seed 82103303",
					"codex oracle traces, seed 82103203",
					"codex oracle traces, seed 82103300",
					"codex oracle traces, seed 82103301",
					"codex oracle traces, seed 82103303",
					"cursor oracle traces, seed 82103301",
					"cursor oracle traces, seed 82103302",
					"opencode oracle traces, seed 82103201",
					"opencode oracle traces, seed 82103202",
					"opencode oracle traces, seed 82103300",
					"opencode oracle traces, seed 82103301",
					"opencode oracle traces, seed 82103303",
				],
			],
			[
				"coverage (generated shapes and races stop with the failing traces above)",
				[
					...[
						"confirm copied before a query replacement",
						"joined Run's not_sent start retried in its execution",
						"native clock resumed at re-issue",
						"not_sent no-hold steer",
						"not_sent start ended its Run",
						"Q28 journal settle",
						"relaunch after unlaunch",
						"unheld_outcome after a reissue",
						"unheld_outcome after its runner retired",
						"unlaunch by retryable",
					].map((shape) => `generated traces reach ${shape}`),
					"fixed catalogue race gate",
				],
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
