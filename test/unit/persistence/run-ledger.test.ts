// The catalogue's ledger cases the arm reaches today (32.3), against real SQLite through the
// projecting write. Each case's other half stays a todo under its owning ticket. How they could fail:
// 1. a second terminal, a late status or a runner's exit ends a Run twice, or under the later outcome;
// 2. a runner's exit leaves a dispatched Run open, so its session never reads Quiescent;
// 3. a Stop before intake ends the Run at its commit, or the host's terminal never ends it;
// 4. a late dispatch on a replacement runner binds an ended Run, or issues an effect for it;
// 5. an arm read scans events, the outbox or the ledger instead of searching an index;
// 6. a folded indeterminate delivery leaves the session's version where it was.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { loadLedgerView } from "../../../src/lib/persistence/effect/run-ledger-arm.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

const withStore = <A, E>(
	effect: Effect.Effect<A, E, PersistenceEffectContext>,
) =>
	Effect.acquireUseRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), "run-ledger-rl-"))),
		(dir) =>
			effect.pipe(
				Effect.provide(
					makePersistenceEffectLayer(join(dir, "events.db"), "test-project"),
				),
			),
		(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
	);

type Provider = "claude" | "opencode" | "cursor";
const at = (provider: Provider, createdAt: number, metadata = {}) => ({
	createdAt,
	metadata,
	provider,
});

/** Session s1's input u1 admitted, handed off and requested as Run r1, then started unless not. */
const turn = (provider: Provider, started = true) => [
	makeSessionCreatedEvent("s1", { provider, createdAt: 1000 }),
	canonicalEvent(
		"input.admitted",
		"s1",
		{
			sessionId: "s1",
			inputId: "u1",
			delivery: "queue",
			request: { text: "hi", images: [] },
		},
		at(provider, 1001),
	),
	canonicalEvent(
		"input.sent",
		"s1",
		{ sessionId: "s1", inputId: "u1" },
		at(provider, 1002),
	),
	canonicalEvent(
		"run.requested",
		"s1",
		{ runId: "r1", inputId: "u1" },
		at(provider, 1003, { runId: "r1" }),
	),
	...(started
		? [
				canonicalEvent(
					"run.started",
					"s1",
					{ inputId: "u1", requestedRunId: "r1" },
					at(provider, 1004, { runId: "r1" }),
				),
			]
		: []),
];

const stop = (provider: Provider, createdAt: number) =>
	canonicalEvent(
		"interrupt.requested",
		"s1",
		{
			providerProcessId: "p1",
			stop: {
				deadlineAt: createdAt + 30_000,
				owners: [{ runId: "r1" }],
				turnIds: [],
				runnerBacked: provider === "claude" || provider === "cursor",
				retainedSteers: false,
			},
		},
		at(provider, createdAt, { commandId: "k1" }),
	);

const project = (events: readonly CanonicalEvent[]) =>
	Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		yield* runner.recover();
		for (const event of events)
			yield* runner.projectEvent(yield* store.append(event));
	});

/** Run r1's end entries, s1's view, its ledger row and the ledger effects naming r1. */
const settled = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return {
		ends: (yield* sql<{ entry_json: string }>`
			SELECT entry_json FROM run_ledger_entries
			WHERE session_id = 's1' AND json_extract(entry_json, '$.kind') = 'end'
				AND json_extract(entry_json, '$.runId') = 'r1'
			ORDER BY entry_seq`).map(({ entry_json }): unknown =>
			JSON.parse(entry_json),
		),
		view: yield* loadLedgerView("s1"),
		row: yield* sql`SELECT state, alarm_at FROM run_ledger_sessions WHERE session_id = 's1'`,
		effects:
			yield* sql`SELECT command_id FROM provider_command_outbox WHERE command_id LIKE 'ledger:r1:%'`,
	};
});
const quiescent = [{ state: "Quiescent", alarm_at: null }];

describe("Run Ledger ledger regressions the arm reaches", () => {
	it.effect(
		"RL-006: an OpenCode turn.error then a late idle for the same Run end it once",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						...turn("opencode"),
						canonicalEvent(
							"turn.error",
							"s1",
							{ messageId: "m1", error: "boom", code: "provider_error" },
							at("opencode", 1005, { runId: "r1" }),
						),
					]);
					const errored = yield* settled;
					expect(errored.ends).toMatchObject([{ outcome: "error" }]);
					expect(errored.view?.active).toBeUndefined();
					expect(errored.row).toEqual(quiescent);
					yield* project([
						canonicalEvent(
							"session.status",
							"s1",
							{ sessionId: "s1", status: "idle" },
							at("opencode", 1006, { runId: "r1" }),
						),
					]);
					expect(yield* settled).toEqual(errored);
				}),
			),
	);

	it.effect(
		"RL-012: the runner's exit ends its dispatched Run once, and a late cleanup error adds nothing",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						...turn("claude"),
						canonicalEvent(
							"evidence.process_started",
							"s1",
							{ runnerId: "R1", label: "R1:1", reattached: false },
							at("claude", 1005),
						),
						canonicalEvent(
							"run.dispatched",
							"s1",
							{ runId: "r1", runnerId: "R1", commandId: "c1", transmission: 1 },
							at("claude", 1006),
						),
						canonicalEvent(
							"evidence.process_lost",
							"s1",
							{ runnerId: "R1", retiredAt: 1007 },
							at("claude", 1007),
						),
					]);
					const lost = yield* settled;
					expect(lost.ends).toMatchObject([
						{ outcome: "error", reason: { tag: "process_lost" } },
					]);
					expect(lost.view?.active).toBeUndefined();
					expect(lost.row).toEqual(quiescent);
					yield* project([
						canonicalEvent(
							"turn.error",
							"s1",
							{ messageId: "m1", error: "runner exited" },
							at("claude", 1008, { runId: "r1" }),
						),
					]);
					expect(yield* settled).toEqual(lost);
				}),
			),
	);

	it.effect(
		"RL-016: a Stop on a placed Cursor input before intake holds the Run until the host's terminal ends it interrupted",
		() =>
			withStore(
				Effect.gen(function* () {
					// Cursor's runner placed the input; Stop arrives before its RUNNING frame (run.started).
					yield* project([
						...turn("cursor", false),
						canonicalEvent(
							"evidence.process_started",
							"s1",
							{ runnerId: "R1", label: "R1:1", reattached: false },
							at("cursor", 1004),
						),
						canonicalEvent(
							"run.dispatched",
							"s1",
							{ runId: "r1", runnerId: "R1", commandId: "c1", transmission: 1 },
							at("cursor", 1005),
						),
						stop("cursor", 1006),
					]);
					const stopping = yield* settled;
					expect(stopping.ends).toEqual([]);
					expect(stopping.view?.active).toMatchObject({
						runId: "r1",
						tag: "Interrupting",
						by: "stop",
					});
					expect(
						stopping.view?.active?.inputs.map(({ state }) => state.tag),
					).not.toContain("Accepted");
					yield* project([
						canonicalEvent(
							"turn.interrupted",
							"s1",
							{ messageId: "m1" },
							at("cursor", 1007, { runId: "r1" }),
						),
					]);
					const ended = yield* settled;
					expect(ended.ends).toMatchObject([{ outcome: "interrupted" }]);
					expect(ended.view?.active).toBeUndefined();
					expect(ended.row).toEqual(quiescent);
				}),
			),
	);

	it.effect(
		"RL-047: a released Run's late dispatch on a replacement runner binds nothing after Stop and retirement",
		() =>
			withStore(
				Effect.gen(function* () {
					const hold = (runnerId: string, transmission: number) => ({
						runId: "r1",
						runnerId,
						commandId: "c1",
						transmission,
					});
					yield* project([
						...turn("claude"),
						canonicalEvent(
							"evidence.process_started",
							"s1",
							{ runnerId: "R1", label: "R1:1", reattached: false },
							at("claude", 1005),
						),
						canonicalEvent(
							"run.dispatched",
							"s1",
							hold("R1", 1),
							at("claude", 1006),
						),
						canonicalEvent(
							"run.released",
							"s1",
							{ ...hold("R1", 1), reason: "JournalAbsent" },
							at("claude", 1007),
						),
						stop("claude", 1008),
						canonicalEvent(
							"turn.interrupted",
							"s1",
							{ messageId: "m1" },
							at("claude", 1009, { runId: "r1" }),
						),
						canonicalEvent(
							"evidence.process_lost",
							"s1",
							{ runnerId: "R1", retiredAt: 1010 },
							at("claude", 1010),
						),
						canonicalEvent(
							"evidence.process_started",
							"s1",
							{ runnerId: "R2", label: "R2:1", reattached: false },
							at("claude", 1011),
						),
					]);
					const retired = yield* settled;
					expect(retired.ends).toMatchObject([{ outcome: "interrupted" }]);
					yield* project([
						canonicalEvent(
							"run.dispatched",
							"s1",
							hold("R2", 2),
							at("claude", 1012),
						),
					]);
					expect(yield* settled).toEqual(retired);
					expect(retired.effects).toEqual([]);
				}),
			),
	);

	it.effect(
		"RL-061: a cleanup turn.error after Claude's completion leaves the Run ended completed",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						...turn("claude"),
						canonicalEvent(
							"turn.completed",
							"s1",
							{ messageId: "m1" },
							at("claude", 1005, { runId: "r1" }),
						),
					]);
					const completed = yield* settled;
					expect(completed.ends).toMatchObject([{ outcome: "completed" }]);
					yield* project([
						canonicalEvent(
							"turn.error",
							"s1",
							{ messageId: "m1", error: "cleanup failed" },
							at("claude", 1006, { runId: "r1" }),
						),
					]);
					expect(yield* settled).toEqual(completed);
				}),
			),
	);

	it.effect(
		"RL-063: the arm's reads search an index, whatever the session's or the outbox's history",
		() =>
			withStore(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					// The arm's reads (run-ledger-arm.ts), each as it runs there.
					const reads = [
						"SELECT provider, state, alarm_at FROM run_ledger_sessions WHERE session_id = 's1'",
						"SELECT provider FROM sessions WHERE id = 's1'",
						"SELECT entry_seq, event_sequence, stamp, entry_json FROM run_ledger_entries WHERE session_id = 's1' ORDER BY entry_seq",
						`SELECT json_remove(json_extract(data, '$.request'), '$.images') AS request FROM events
							WHERE session_id = 's1' AND type = 'input.admitted'
								AND json_extract(data, '$.inputId') = 'u1' AND sequence < 9
							ORDER BY sequence DESC LIMIT 1`,
						`SELECT type, json_extract(data, '$.inputId') AS input_id FROM events
							WHERE session_id = 's1'
								AND type IN ('input.interrupt_requested', 'interrupt.requested') AND sequence < 9
							ORDER BY sequence DESC LIMIT 1`,
						`SELECT COALESCE(MAX(request_sequence), 0) + 1, 'ledger:r1:probe:t',
								(SELECT provider FROM sessions WHERE id = 's1'), 'pending'
							FROM provider_command_outbox`,
						"UPDATE sessions SET version = 1 WHERE id = 's1'",
					];
					const plans = yield* Effect.forEach(reads, (read) =>
						sql
							.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${read}`)
							.pipe(Effect.map((rows) => rows.map(({ detail }) => detail))),
					);
					expect(
						plans
							.flat()
							.filter(
								(detail) =>
									detail.startsWith("SCAN") ||
									(detail.startsWith("SEARCH events") &&
										!detail.includes("(session_id=?")),
							),
					).toEqual([]);
				}),
			),
	);

	it.effect(
		"RL-113: a folded indeterminate delivery advances the session's version",
		() =>
			withStore(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const version = sql<{
						version: number;
					}>`SELECT version FROM sessions WHERE id = 's1'`;
					yield* project(turn("opencode"));
					const [before] = yield* version;
					yield* project([
						canonicalEvent(
							"evidence.delivery_indeterminate",
							"s1",
							{ runId: "r1", commandId: "c1" },
							at("opencode", 1005, { runId: "r1" }),
						),
					]);
					const [after] = yield* version;
					expect(after?.version).toBeGreaterThan(
						before?.version ?? Number.POSITIVE_INFINITY,
					);
				}),
			),
	);
});

// Cases and source evidence: docs/plans/2026-10-22-run-ledger-failure-catalogue.md.
describe("Run Ledger ledger regressions", () => {
	it.todo("RL-001: Preserve active ownership during upgrade backfill");
	it.todo(
		"RL-002: Reconcile external OpenCode runs without commands after restart",
	);
	it.todo(
		"RL-004: Invalidate sampled OpenCode idle when new input is accepted",
	);
	it.todo("RL-006: the receipt and command views (25scs)");
	it.todo("RL-007: Reconcile every accepted input belonging to the same Run");
	it.todo("RL-008: Recover an open Run despite an already-completed command");
	it.todo("RL-011: Retain pre-intake input identity at a processing deadline");
	it.todo("RL-012: the placed input's settlement (32.6)");
	it.todo("RL-015: Preserve an exact input failure before provider delivery");
	it.todo("RL-016: the Stop's pause (32.8, 32.13)");
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
	it.todo("RL-047: the interpreter's claim before delivery (32.6, 32.29.2)");
	it.todo(
		"RL-051: Settle indeterminate inputs after confirmed runner retirement",
	);
	it.todo("RL-057: Attach legacy output placed after hello to its exact input");
	it.todo("RL-060: Do not let duplicate placement discard an owned failure");
	it.todo("RL-061: no false error card (25scs)");
	it.todo("RL-062: Retain admitted handoff data during live-command recovery");
	it.todo("RL-063: main's ownership select through the view (25scs)");
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
	it.todo("RL-113: canStop from the view and the sidebar delta (25scs)");
	it.todo("RL-115: Recover a targeted answer interrupted after claim");
	it.todo(
		"RL-116: Attribute out-of-order cumulative accounting without miscounting",
	);
});
