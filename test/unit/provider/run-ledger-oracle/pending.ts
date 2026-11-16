import { it } from "vitest";

/**
 * A property pend: main's own direct start meets its gate at removal and the gate refuses it before main
 * has read its run.requested. CONTRACT.md 1820-1821 gives the removal refusal to "the refused send" and
 * says a row main's executor runs gets no gate outcome (3.4), but not whether main's Run ends on it, so
 * the ledger keeps the start possibly reached while the fake has it unsent. The fake skips its D50 Stop
 * and retirement checks for such a Run until a contract round decides; the entry goes with that rule.
 */
export const mainGateRefusal =
	"[gap] main's own direct start refused by its gate at removal";

/**
 * A property pend: OpenCode reports a late turn (started, activity or a question) on a start whose Run
 * main already ended. The same gap as the review traces below, CONTRACT.md 871-876 against 3086-3089:
 * GAP 5 ends the Run's work at main's terminal, section 9 keeps an unconfirmed send able to run late
 * (655-662). The fake leaves such a turn out of its LI8 checks until a contract round decides.
 */
export const openCodeLateTurn =
	"[gap] OpenCode late turn of a Run main already ended";

// Remove an entry when its implementation lands; an unexpected pass fails the suite.
export const pendingCases: ReadonlyMap<string, string> = new Map([
	// 32.2.3/32.2.4 convergence: each entry is a live test the oracle and the fake still disagree on, keyed by
	// the first check it fails. The contract is frozen at 7732bd85 and does not decide the gap below, so
	// the wrong side is undecided and these stay pended until a contract round names it.
	...(
		[
			[
				"LI8, CONTRACT.md 871-876 against 3086-3089 (gap, GAP 5 against section 9: when OpenCode work ends. GAP 5 ends a main-run Run once main's terminal folds; section 9 keeps the native fence until a covering idle probe. Wrong side undecided: the oracle hides an unfinished native send, the fake keeps it)",
				[
					"review trace R1-2",
					"review trace R1-3",
					"review trace R1-4",
					"review trace R2-1",
					"review trace R2-2",
				],
			],
		] as const
	).flatMap(([disagreement, names]) =>
		names.map((name): [string, string] => [
			`[convergence] ${name}`,
			`32.2.3/32.2.4: oracle and fake disagree on ${disagreement}`,
		]),
	),
	[
		openCodeLateTurn,
		"CONTRACT.md 871-876 against 3086-3089 (GAP 5 against section 9): whether OpenCode work of a Run main ended can still run late is undecided; for vkira",
	],
	[
		mainGateRefusal,
		"CONTRACT.md 1820-1821 (3.4, H4): whether main's Run ends when its own gate refuses its direct start at removal is undecided; for vkira",
	],
]);

/** A suite's decider tests stay red until its core lands. */
export function pendingSuite(name: string): typeof it.fails {
	return pendingCases.has(name) ? it.fails : it;
}
