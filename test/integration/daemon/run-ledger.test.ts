import { describe, it } from "vitest";

// Cases and source evidence: docs/plans/2026-10-22-run-ledger-failure-catalogue.md.
// Implement with the isolated process harness, recorded traces and per-case JSON artifacts.
describe("Run Ledger e2e regressions", () => {
	it.todo("RL-005: Probe OpenCode in the native session directory");
	it.todo(
		"RL-009: Settle migrated legacy results including folded joined inputs",
	);
	it.todo(
		"RL-020: Do not turn transport timeout into proof of native cancellation",
	);
	it.todo(
		"RL-029: Do not authorize shared OpenCode abort with stale local exclusivity",
	);
	it.todo("RL-032: Fence in-flight OpenCode delivery across Stop");
	it.todo("RL-048: Bound the entire replacement warm-up attempt");
	it.todo("RL-052: Expose restart rejection and timeout despite cleanup");
	it.todo(
		"RL-053: Preserve interaction support on a retried background delivery",
	);
	it.todo(
		"RL-058: Defer recoverable resume failure until authorized fallback resolves",
	);
	it.todo("RL-059: Keep Stop visible for a delivery-unknown retained steer");
	it.todo(
		"RL-065: Quarantine a failed runner stop without disabling its project",
	);
	it.todo("RL-078: Recover Stop deadlines independently of delivery receipts");
	it.todo("RL-081: Bound question-replacement interruption");
	it.todo("RL-085: Retain undelivered forced retirement across downtime");
	it.todo("RL-087: Keep shared OpenCode abort fenced through execution");
	it.todo(
		"RL-091: Preserve every process-proof scenario under concurrent writers",
	);
	it.todo(
		"RL-092: Preserve accepted effects during temporary relay replacement",
	);
	it.todo(
		"RL-096: Verify surviving native ownership before synthetic project refusal",
	);
	it.todo("RL-105: Preserve the admitted idle policy on daemon replay");
	it.todo("RL-106: Preserve retained idle policy when a legacy send omits it");
	it.todo(
		"RL-108: Preserve admitted idle policy across warm runner replacement",
	);
	it.todo(
		"RL-109: Do not seed replacement policy from a send refused before admission",
	);
	it.todo(
		"RL-110: Respect a newer legacy admission before restoring an old policy",
	);
	it.todo(
		"RL-111: Reconcile journal admission before choosing replacement idle policy",
	);
	it.todo(
		"RL-112: Forward the shared config snapshot to dynamically added projects",
	);
	it.todo("RL-114: Settle recovered failures for fallback-suffixed bindings");
});
