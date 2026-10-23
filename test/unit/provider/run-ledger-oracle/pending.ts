import { it, type TestFunction } from "vitest";

// Remove an entry when its implementation lands; an unexpected pass fails the suite.
export const pendingCases: ReadonlyMap<string, string> = new Map([
	[
		"[step1] decider correlation contract [8C] uncertainty remains a resend barrier after its Run disappears from the view",
		"step 5 (8C)",
	],
	[
		"[step1] decider correlation contract [5C] conflicting result evidence cannot replace a recorded failure or extend settlement",
		"step 4 (5C)",
	],
	[
		"[step1] decider correlation contract [8C] unknown evidence drops but known incompatible retired sends reject",
		"step 5 (8C)",
	],
	[
		"[step1] decider amendment [step1] first admission projects exactly one alarm and issues only start",
		"D1",
	],
	[
		"[step1] decider amendment [5C] failure wins the outcome fold in order error,completed,interrupted",
		"step 4 (5C)",
	],
	[
		"[step1] decider amendment [5C] failure wins the outcome fold in order interrupted,error,completed",
		"step 4 (5C)",
	],
	[
		"[step1] decider amendment [5C] failure wins the outcome fold in order completed,error,interrupted",
		"step 4 (5C)",
	],
	[
		"[step1] decider amendment [5C] failure wins the outcome fold in order error,interrupted,completed",
		"step 4 (5C)",
	],
	[
		"[step1] decider amendment [5C] completion beats interrupt fallback and a Tombstone is immutable",
		"step 4 (5C)",
	],
	[
		"[step1] decider amendment [8C] very old receipts retain their address and native identity after many finished Runs",
		"step 5 (8C)",
	],
	[
		"[step1] decider amendment [9B] Resume and provider-session end cannot clear project inactivity",
		"9B",
	],
	[
		"[step1] decider amendment [10B] permanent refusal stays Pending and reconciliation retries the preserved answer",
		"10B",
	],
	[
		"[step1] decider amendment [10B] an ambiguous earlier answer is reconciled before retransmission after refusal",
		"10B",
	],
	[
		"[step1] claude public command traces [step1] agrees with active reference traces after every command",
		"step 3 (R3)",
	],
	[
		"[step1] claude public command traces [step1] agrees with session-ending reference traces after every command",
		"step 3 (R3)",
	],
	[
		"[step1] cursor public command traces [step1] agrees with active reference traces after every command",
		"step 3 (R3)",
	],
	[
		"[step1] cursor public command traces [step1] agrees with session-ending reference traces after every command",
		"step 3 (R3)",
	],
	[
		"[step1] opencode public command traces [step1] agrees with active reference traces after every command",
		"step 3 (R3)",
	],
	[
		"[step1] opencode public command traces [step1] agrees with session-ending reference traces after every command",
		"step 3 (R3)",
	],
	[
		"[step1] Run Ledger catalogue scenarios [9B] ordinary Stop returns the unaccepted steer behind the persistent pause (RL-041) [9B] ordinary Stop returns the unaccepted steer behind the persistent pause decider",
		"9B",
	],
	[
		"[step1] Run Ledger catalogue scenarios [5C] late first-answer confirmation cannot overwrite an actual error result (R10-3) [5C] late first-answer confirmation cannot overwrite an actual error result decider",
		"step 4 (5C)",
	],
]);

export function oracleTest(suiteName: string) {
	return (name: string, body: TestFunction) =>
		(pendingCases.has(`${suiteName} ${name}`) ? it.fails : it)(name, body);
}
