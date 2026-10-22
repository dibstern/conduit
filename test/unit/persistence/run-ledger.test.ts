import { describe, it } from "vitest";

// Cases and source evidence: docs/plans/2026-10-22-run-ledger-failure-catalogue.md.
describe("Run Ledger ledger regressions", () => {
	it.todo("RL-001: Preserve active ownership during upgrade backfill");
	it.todo(
		"RL-002: Reconcile external OpenCode runs without commands after restart",
	);
	it.todo(
		"RL-004: Invalidate sampled OpenCode idle when new input is accepted",
	);
	it.todo(
		"RL-006: Settle run and command views together on owned non-stream terminals",
	);
	it.todo("RL-007: Reconcile every accepted input belonging to the same Run");
	it.todo("RL-008: Recover an open Run despite an already-completed command");
	it.todo("RL-011: Retain pre-intake input identity at a processing deadline");
	it.todo("RL-012: Settle placed unaccepted input when its runner exits");
	it.todo("RL-015: Preserve an exact input failure before provider delivery");
	it.todo("RL-016: Preserve the pending Cursor input on Stop before intake");
	it.todo(
		"RL-018: Do not manufacture success from migration-interrupted OpenCode history",
	);
	it.todo("RL-022: Keep copied fork history outside live Run membership");
	it.todo(
		"RL-023: Do not idle another Run's children when a steer is declined",
	);
	it.todo("RL-024: Do not copy native agent identity into a fork");
	it.todo("RL-026: Preserve failed pre-intake history when forking");
	it.todo("RL-035: Keep unclaimed input queued when Stop pauses the inbox");
	it.todo("RL-042: Derive inbox busy and pause from one ledger view");
	it.todo("RL-043: Place a continuation once per admitted attempt");
	it.todo("RL-044: Do not let replayed compaction markers steal a new input");
	it.todo("RL-046: Trigger OpenCode recaps from committed Run completion");
	it.todo("RL-047: Revalidate a held recovery attempt before delivery");
	it.todo(
		"RL-051: Settle indeterminate inputs after confirmed runner retirement",
	);
	it.todo("RL-057: Attach legacy output placed after hello to its exact input");
	it.todo("RL-060: Do not let duplicate placement discard an owned failure");
	it.todo(
		"RL-061: Check terminal ownership inside failure cleanup transaction",
	);
	it.todo("RL-062: Retain admitted handoff data during live-command recovery");
	it.todo(
		"RL-063: Index active ownership reads independently of command history size",
	);
	it.todo(
		"RL-064: Resolve durable questions when refusing an incompatible runner",
	);
	it.todo(
		"RL-066: Detach duplicate control waiters without cancelling shared work",
	);
	it.todo(
		"RL-067: Retain ordinary Stop pause after the pending steer finishes",
	);
	it.todo("RL-068: Persist permission-timeout rejection delivery atomically");
	it.todo(
		"RL-069: Cancel inactive-project effects without blocking shared OpenCode",
	);
	it.todo("RL-070: Recover transiently failed permission and question answers");
	it.todo(
		"RL-071: Keep unrelated interactions owned by a quarantined live runner",
	);
	it.todo(
		"RL-073: Preserve deferred answer reconciliation after delivery exhaustion",
	);
	it.todo(
		"RL-074: Publish newly admitted controls only when execution ownership is durable",
	);
	it.todo("RL-076: Respect the persisted effect budget across a crash");
	it.todo("RL-077: Do not exhaust a still-executing recovered answer");
	it.todo("RL-084: Preserve immutable legacy Stop payload on replay");
	it.todo("RL-086: Recover an answer that expires before native delivery");
	it.todo(
		"RL-088: Probe runner answer consumption before reopening a timed-out prompt",
	);
	it.todo("RL-093: Recover controls imported after initial startup");
	it.todo("RL-094: Preserve refused unplaced user input durably");
	it.todo("RL-095: Settle claimed unaccepted work for inactive projects");
	it.todo(
		"RL-097: Retain late accounting without changing an interrupted lifecycle",
	);
	it.todo(
		"RL-098: Fence new claims while replacement attachment recovery selects work",
	);
	it.todo("RL-099: Retain historical accounting after a prompt is reused");
	it.todo(
		"RL-100: Do not confuse a refusal lock with live execution ownership",
	);
	it.todo(
		"RL-101: Resolve persisted parents for separately batched late accounting",
	);
	it.todo("RL-102: Keep execution ownership specific to each retry attempt");
	it.todo(
		"RL-103: Reconcile cancelled pending OpenCode reservations on project return",
	);
	it.todo("RL-104: Honor explicit input ownership on late bare SDK results");
	it.todo("RL-113: Publish a sidebar delta when control availability changes");
	it.todo("RL-115: Recover a targeted answer interrupted after claim");
	it.todo(
		"RL-116: Attribute out-of-order cumulative accounting without miscounting",
	);
});
