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
	// 32.2.3/32.2.4 convergence: the oracle and the fake still disagree on LI3 (an Ended Run active
	// again), LI5 (L2 case 2: an end_session for a Run with an execution carries null, not its
	// runner's label), LI7 (older-label liveness), LI8 (a running turn hidden), D50 (an OpenCode
	// retirement leaves a reached main run unended). Generated coverage stops with the failing traces.
	...[
		...["claude", "codex", "opencode"].flatMap((provider) =>
			[
				82103200, 82103201, 82103202, 82103203, 82103300, 82103301, 82103302,
				82103303,
			].map((seed) => `${provider} oracle traces, seed ${seed}`),
		),
		...[82103200, 82103202, 82103300, 82103301, 82103302, 82103303].map(
			(seed) => `cursor oracle traces, seed ${seed}`,
		),
		...[
			"confirm copied before a query replacement",
			"joined Run's not_sent start retried in its execution",
			"long not_sent run",
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
	].map((name): [string, string] => [
		`[convergence] ${name}`,
		"32.2.3/32.2.4: oracle and fake disagree (LI3, LI5, LI7, LI8, D50)",
	]),
]);

/** A suite's decider tests stay red until its core lands. */
export function pendingSuite(name: string): typeof it.fails {
	return pendingCases.has(name) ? it.fails : it;
}
