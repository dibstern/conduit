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

// Remove an entry when its implementation lands; an unexpected pass fails the suite.
export const pendingCases: ReadonlyMap<string, string> = new Map([
	[
		mainGateRefusal,
		"CONTRACT.md 1820-1821 (3.4, H4): whether main's Run ends when its own gate refuses its direct start at removal is undecided; for vkira",
	],
]);

/** A suite's decider tests stay red until its core lands. */
export function pendingSuite(name: string): typeof it.fails {
	return pendingCases.has(name) ? it.fails : it;
}
