import { it, type TestFunction } from "vitest";

// Remove an entry when its implementation lands; an unexpected pass fails the suite.
export const pendingCases: ReadonlyMap<string, string> = new Map([
	[
		"[checkpoint] run-ledger-oracle-scenarios",
		"32.2.5 onward: public core and background slices",
	],
	[
		"[checkpoint] run-ledger-differential",
		"32.2.5 onward: public core differential",
	],
	[
		"[checkpoint] run-ledger-r5-fence",
		"32.2.4 hold-aware public trace migration; 32.2.6 sibling fence",
	],
	[
		"[checkpoint] run-ledger-decider",
		"32.2.4 public trace migration; 32.2.5–32.2.8 core",
	],
	[
		"[checkpoint] run-ledger-evidence-order",
		"32.2.4 public trace migration; 32.2.5–32.2.8 core",
	],
	[
		"[checkpoint] run-ledger-transmission-proof",
		"32.2.4 public trace migration; 32.2.5–32.2.8 core",
	],
	[
		"[checkpoint] run-ledger-terminal",
		"32.2.4 public trace migration; 32.2.5–32.2.8 core",
	],
	[
		"[checkpoint] decider amendment parameterized cases",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider correlation contract [step1] native input acceptance cannot be downgraded by a late uncertain transport outcome",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider correlation contract [step1] an obsolete retry deadline cannot resend an uncertain input",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider correlation contract [step1] a start retry scheduled before Stop cannot start while interrupting",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider correlation contract [8C] a receipt for an earlier admission cannot accept the reused input's new admission",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider correlation contract [step1] native acceptance during backoff removes its retry deadline",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider correlation contract [10B] an answer confirmation cannot settle a different interaction on the same Run",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider correlation contract [step1] native answer consumption during backoff removes its retry deadline",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider correlation contract [4B] native idle removes old cleanup and leaves only the successor deadline",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider correlation contract [7B] session end removes deadlines and permits fresh authorized admission",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [step1] a late alarm fires every due obligation in deadline order once",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [R1] an unanswered input probe owns a deadline from issue and re-probes at it",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [R1] an unanswered interaction probe owns a deadline from issue and re-probes at it",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [R1] an unanswered native_session probe owns a deadline from issue and re-probes at it",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [step1] probe retry is data and fulfillment removes its deadline",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [2C] Claude result ends the Run while its query fence holds the next start",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [2C] OpenCode result supplies outcome until the owned execution ends",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [4B] OpenCode idle cannot discharge a request or abort that may still execute",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [5C] failure wins the outcome fold in order completed,interrupted,error",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [5C] failure wins the outcome fold in order interrupted,completed,error",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [5C] specific beats generic and the first specific code survives later failures",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [6C] native identity fills once and contradictions reject without changing state or alarm",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [6C] a contradictory input probe rejects even after native acceptance",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [7B] ending an empty provider session with usage_limit_failover permits fresh authorization",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] decider amendment [7B] ending an empty provider session with native_session_vanished permits fresh authorization",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [step1] a spurious alarm after process loss leaves a newer Run before its deadline (RL-003) [step1] a spurious alarm after process loss leaves a newer Run before its deadline decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] an owned idle boundary cannot accept a delivered steer (RL-010) [2C] an owned idle boundary cannot accept a delivered steer decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [5C] a new authorization after a retryable result gets a fresh Run (RL-013) [5C] a new authorization after a retryable result gets a fresh Run decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] OpenCode tool progress is activity rather than a terminal (RL-014) [2C] OpenCode tool progress is activity rather than a terminal decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [5C] a successful OpenCode tool-step cannot mask the final failure (RL-017) [5C] a successful OpenCode tool-step cannot mask the final failure decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] a Claude failure before started retains the Starting owner (RL-019) [2C] a Claude failure before started retains the Starting owner decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [step1] unknown OpenCode intake keeps its deadline and probes (RL-021) [step1] unknown OpenCode intake keeps its deadline and probes decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [step1] recalling an uncertain steer never ends its running owner (RL-025) [step1] recalling an uncertain steer never ends its running owner decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] a successful SDK handoff proves delivery, never acceptance (RL-027) [2C] a successful SDK handoff proves delivery, never acceptance decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [step1] an alarm before the successor deadline cannot interrupt it (RL-028) [step1] an alarm before the successor deadline cannot interrupt it decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [step1] uncertain intake does not block durable later admission (RL-030) [step1] uncertain intake does not block durable later admission decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [6C] an unknown OpenCode send cannot accept the only pending input (RL-031) [6C] an unknown OpenCode send cannot accept the only pending input decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] replacement intake waits for the stopped native query to close (RL-033) [2C] replacement intake waits for the stopped native query to close decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] a pre-intake native Claude result ends its exact Starting Run (RL-034) [2C] a pre-intake native Claude result ends its exact Starting Run decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [7B] usage-limit failover settles the session with its typed reason once (RL-036) [7B] usage-limit failover settles the session with its typed reason once decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [5C] a classified provider error preserves outcome and typed reason (RL-037) [5C] a classified provider error preserves outcome and typed reason decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] an old input limit result cannot settle the replacement Run (RL-038) [2C] an old input limit result cannot settle the replacement Run decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] a slow Stop acknowledgement cannot consume resumed work (RL-039) [2C] a slow Stop acknowledgement cannot consume resumed work decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] an unowned OpenCode assistant error cannot settle the active Run (RL-040) [2C] an unowned OpenCode assistant error cannot settle the active Run decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [step1] Run now joins an existing Stop and makes progress after close (RL-045) [step1] Run now joins an existing Stop and makes progress after close decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] Cursor steer delivery acknowledgement is not a Run result (RL-054) [2C] Cursor steer delivery acknowledgement is not a Run result decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [step1] provider-handled uncertain delivery probes instead of creating a second start (RL-055) [step1] provider-handled uncertain delivery probes instead of creating a second start decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [step1] a declined Cursor steer returns to the inbox without pausing (RL-056) [step1] a declined Cursor steer returns to the inbox without pausing decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [10B] permanent answer failure has reconciliation rather than endless delivery retries (RL-072) [10B] permanent answer failure has reconciliation rather than endless delivery retries decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [step1] a throttled answer is retained and retried with a fresh send token (RL-075) [step1] a throttled answer is retained and retried with a fresh send token decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [9B] an idle Stop issues no control that could target future work (RL-079) [9B] an idle Stop issues no control that could target future work decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] natural completion makes queued forced retirement obsolete (RL-080) [2C] natural completion makes queued forced retirement obsolete decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] an empty Stop cannot own intake admitted afterwards (RL-082) [2C] an empty Stop cannot own intake admitted afterwards decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] natural completion retires an unacknowledged runner interrupt (RL-083) [2C] natural completion retires an unacknowledged runner interrupt decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] an owned runner terminal releases the selected Run now input (RL-089) [2C] an owned runner terminal releases the selected Run now input decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [2C] an obsolete recovered Stop never sends again after its Run ends (RL-090) [2C] an obsolete recovered Stop never sends again after its Run ends decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [step1] ROUND10-1 retained close cannot release current cleanup (R10-1) [step1] ROUND10-1 retained close cannot release current cleanup decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [9B] a retired input receipt cannot start Run now work on an inactive project (R10-2) [9B] a retired input receipt cannot start Run now work on an inactive project decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [9B] project removal removes an uncertain answer's probe retry deadline (R10-4) [9B] project removal removes an uncertain answer's probe retry deadline decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
	[
		"[step1] Run Ledger catalogue scenarios [step1] a late receipt leaves the original result settlement deadline unchanged (R10-5) [step1] a late receipt leaves the original result settlement deadline unchanged decider",
		"32.2.3 oracle update; 32.2.5–32.2.8 core",
	],
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

/** Whole legacy suites stay red until their public trace migration and core land. */
export function pendingSuite(name: string): typeof it.fails {
	return pendingCases.has(name) ? it.fails : it;
}
