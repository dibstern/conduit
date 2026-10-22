import { describe, it } from "vitest";

// Cases and source evidence: docs/plans/2026-10-22-run-ledger-failure-catalogue.md.
// RL-049, RL-050 and RL-107 are pure source-contract exceptions, not decide/evolve cases.
describe("Run Ledger decider regressions", () => {
	it.todo("RL-003: Keep exact ownership on answer and continuation deadlines");
	it.todo(
		"RL-010: Do not let unrelated OpenCode idle complete an unaccepted input",
	);
	it.todo("RL-013: Give an authorized retry a fresh execution identity");
	it.todo("RL-014: Keep OpenCode tool-step completion nonterminal");
	it.todo(
		"RL-017: Require final successful OpenCode loop evidence during recovery",
	);
	it.todo("RL-019: Own Claude iterator failures before intake");
	it.todo("RL-021: Retain a deadline after a missed OpenCode acceptance echo");
	it.todo(
		"RL-025: Recall an unaccepted input without ending another active Run",
	);
	it.todo("RL-027: Do not treat SDK handoff as Run Input acceptance");
	it.todo(
		"RL-028: Keep delayed timeout controls from interrupting a successor",
	);
	it.todo("RL-030: Bound recall without holding later admission forever");
	it.todo("RL-031: Match OpenCode acceptance to the exact native message id");
	it.todo("RL-033: Do not attach replacement input to an ended native context");
	it.todo("RL-034: Own exact Claude native results received before intake");
	it.todo(
		"RL-036: Settle usage-limit failover with an explicit session reason",
	);
	it.todo(
		"RL-037: Classify terminal outcomes once instead of manufacturing events",
	);
	it.todo(
		"RL-038: Resolve pending result ownership before usage-limit interception",
	);
	it.todo("RL-039: Keep slow Stop settlement from consuming a resumed attempt");
	it.todo("RL-040: Leave unknown OpenCode assistant errors unowned");
	it.todo("RL-041: Apply the new Stop contract to retained pending steers");
	it.todo("RL-045: Let Run now join an existing Stop with bounded progress");
	it.todo(
		"RL-049: Keep temporary compatibility removable without rewriting surviving logic",
	);
	it.todo(
		"RL-050: Keep compatibility names and interface documentation accurate",
	);
	it.todo("RL-054: Do not classify legacy Cursor delivered joined as terminal");
	it.todo("RL-055: Preserve provider-handled retry policy in legacy errors");
	it.todo("RL-056: Return a declined steer without pausing the inbox");
	it.todo("RL-072: Classify permanent answer failures without endless retries");
	it.todo("RL-075: Treat OpenCode answer throttling as retryable");
	it.todo("RL-079: Keep a delayed empty Stop away from newer foreground work");
	it.todo(
		"RL-080: Cancel obsolete forced retirement before it reaches a successor",
	);
	it.todo("RL-082: Preserve pending intake when an empty Stop arrives late");
	it.todo("RL-083: Release an obsolete unacknowledged runner interrupt");
	it.todo(
		"RL-089: Expect terminal-driven release for safe runner Stop controls",
	);
	it.todo("RL-090: Expect obsolete recovered Stops to skip native delivery");
	it.todo("RL-107: Detect computed and injected runtime configuration reads");
});
