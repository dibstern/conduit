// The Run Ledger's alarm scheduler (CONTRACT.md 3.7, L6, 2.1 row 215) against real SQLite and the
// arm. How it could fail:
// 1. it fires before a row's alarm_at, or never at it;
// 2. a commit that opens an alarm earlier than its timer does not re-arm it, so it fires late;
// 3. a fire the arm finds nothing due for is fired again and again;
// 4. it appends something other than alarm_fired, or appends it in a write that does not fold it;
// 5. after a restart it does not fire the ledger stop deadline from the session row (no U2 restore).
// 6. its alarm forces a wake an observer already ended at its Stop's dispose (trace W, L6, A.21).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { RunLedgerSchedulerLive } from "../../../src/lib/domain/persistence/Services/run-ledger-scheduler.js";
import {
	type CommitAndSignal,
	makeCommitAndSignal,
} from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

/**
 * One store over the file, with the scheduler running until the body ends (a restart's unit). A
 * test sees the scheduler only through its commits, so the body gets the commit seam, whose
 * `committed()` captures the next commit when called, and the scheduler's first commit, captured
 * before the scheduler starts.
 */
const open = <A, E>(
	file: string,
	body: (
		commit: CommitAndSignal,
		started: Effect.Effect<void>,
	) => Effect.Effect<A, E, PersistenceEffectContext>,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const started = commit.committed();
			yield* Layer.build(RunLedgerSchedulerLive);
			return yield* body(commit, started);
		}),
	).pipe(Effect.provide(makePersistenceEffectLayer(file, "test-project")));

/** A Claude wake running with no main run, then a Stop commit whose ledger stop deadline is at. */
const wakeThenStop = (sessionId: string, deadlineAt: number) => [
	makeSessionCreatedEvent(sessionId, { provider: "claude", createdAt: 100 }),
	canonicalEvent(
		"evidence.process_started",
		sessionId,
		{
			runnerId: `rn-${sessionId}`,
			label: `rn-${sessionId}:1`,
			reattached: false,
		},
		{ provider: "claude", createdAt: 101 },
	),
	canonicalEvent(
		"evidence.turn_started",
		sessionId,
		{ label: `rn-${sessionId}:1` },
		{ provider: "claude", createdAt: 102 },
	),
	canonicalEvent(
		"interrupt.requested",
		sessionId,
		{
			providerProcessId: "p1",
			stop: {
				deadlineAt,
				owners: [],
				turnIds: [],
				runnerBacked: true,
				retainedSteers: false,
			},
		},
		{
			provider: "claude",
			createdAt: 103,
			metadata: { commandId: `stop-${sessionId}` },
		},
	),
];

const observed = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return {
		rows: yield* sql<{
			session_id: string;
			alarm_at: number | null;
		}>`SELECT session_id, alarm_at FROM run_ledger_sessions ORDER BY session_id`,
		alarms: yield* sql<{
			session_id: string;
			created_at: number;
		}>`SELECT session_id, created_at FROM events WHERE type = 'evidence.alarm_fired'
			ORDER BY sequence`,
		// 4: every alarm_fired with a deadline due is folded by the arm in its own write.
		unfolded: yield* sql<{
			session_id: string;
		}>`SELECT e.session_id FROM events e
			WHERE e.type = 'evidence.alarm_fired' AND NOT EXISTS (SELECT 1 FROM run_ledger_entries r
				WHERE r.event_sequence = e.sequence) ORDER BY e.sequence`,
		forced: yield* sql<{ session_id: string }>`SELECT DISTINCT session_id
			FROM run_ledger_entries WHERE entry_json LIKE '%"forced":true%' ORDER BY session_id`,
	};
});

describe("Run Ledger alarm scheduler", () => {
	it.effect(
		"keeps one timer on the earliest alarm, fires each once, and fires the ledger stop deadline after a restart",
		() =>
			Effect.acquireUseRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), "run-ledger-scheduler-"))),
				(dir) =>
					Effect.gen(function* () {
						const file = join(dir, "events.db");
						const before = yield* open(file, (commit) =>
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient;
								// The scheduler is idle with no alarm; these commits must wake it.
								yield* commit(wakeThenStop("s1", 5000));
								yield* commit(wakeThenStop("s2", 3000));
								// A spurious alarm: a row due at 2000 with no deadline behind it.
								yield* commit([
									makeSessionCreatedEvent("s3", {
										provider: "claude",
										createdAt: 100,
									}),
								]);
								yield* sql`INSERT INTO run_ledger_sessions (session_id, provider, state, alarm_at)
									VALUES ('s3', 'claude', 'Open', 2000)`;
								yield* commit(wakeThenStop("s4", 9000));
								const armed = yield* observed;
								// Each wait is for the scheduler's next commit. A fire's created_at is the clock
								// it read, so a fire at 1999 shows as 1999, not 2000.
								const first = commit.committed();
								yield* TestClock.adjust(1999);
								yield* TestClock.adjust(1);
								yield* first;
								const spurious = yield* observed;
								// A refire of the spurious row would be this next commit, not s2's.
								const second = commit.committed();
								yield* TestClock.adjust(1000);
								yield* second;
								return { armed, spurious, s2: yield* observed };
							}),
						);
						// A restart before s1's deadline: a fresh graph over the same file.
						const after = yield* open(file, (commit, started) =>
							Effect.gen(function* () {
								// A fresh scheduler fires the due spurious row once more, at its start.
								yield* started;
								const deadline = commit.committed();
								yield* TestClock.adjust(2000);
								yield* deadline;
								return yield* observed;
							}),
						);
						return { ...before, after };
					}),
				(dir) =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
			).pipe(
				Effect.tap(({ armed, spurious, s2, after }) =>
					Effect.sync(() => {
						// L6: each Stop commit opened the ledger stop deadline at its deadlineAt.
						expect(armed.rows).toEqual([
							{ session_id: "s1", alarm_at: 5000 },
							{ session_id: "s2", alarm_at: 3000 },
							{ session_id: "s3", alarm_at: 2000 },
							{ session_id: "s4", alarm_at: 9000 },
						]);
						expect(armed.alarms).toEqual([]);
						// 1, 3: the spurious row fired at 2000, not before, and not again; its row is as it was.
						expect(spurious.alarms).toEqual([
							{ session_id: "s3", created_at: 2000 },
						]);
						expect(spurious.rows).toEqual(armed.rows);
						// 2: s2's alarm, committed after s1's, fired at its own time.
						expect(s2.alarms).toEqual([
							{ session_id: "s3", created_at: 2000 },
							{ session_id: "s2", created_at: 3000 },
						]);
						expect(
							s2.rows.find((row) => row.session_id === "s2")?.alarm_at,
						).toBe(null);
						expect(s2.forced).toEqual([{ session_id: "s2" }]);
						// 5: after the restart, s1's deadline fired from its row; s4's is still ahead. A fresh
						// scheduler fires the spurious row once more, found with nothing due (3.7).
						expect(after.alarms).toEqual([
							...s2.alarms,
							{ session_id: "s3", created_at: 3000 },
							{ session_id: "s1", created_at: 5000 },
						]);
						expect(after.rows).toEqual([
							{ session_id: "s1", alarm_at: null },
							{ session_id: "s2", alarm_at: null },
							{ session_id: "s3", alarm_at: 2000 },
							{ session_id: "s4", alarm_at: 9000 },
						]);
						expect(after.forced).toEqual([
							{ session_id: "s1" },
							{ session_id: "s2" },
						]);
						// Only the spurious fires fold no entry (a no-op settle, 3.7).
						expect(after.unfolded).toEqual([
							{ session_id: "s3" },
							{ session_id: "s3" },
						]);
					}),
				),
			),
	);
	it.effect(
		"forces nothing at the deadline of a Stop whose wake already ended at its dispose (trace W)",
		() =>
			Effect.acquireUseRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), "run-ledger-scheduler-"))),
				(dir) =>
					open(join(dir, "events.db"), (commit) =>
						Effect.gen(function* () {
							// w: the Stop's dispose ends the wake at once, its turn_ended before deadlineAt.
							yield* commit([
								...wakeThenStop("w", 4000),
								canonicalEvent(
									"evidence.turn_ended",
									"w",
									{ label: "rn-w:1" },
									{ provider: "claude", createdAt: 104 },
								),
							]);
							// x: a wake no observer ends, whose fire at 6000 is the commit to wait for.
							yield* commit(wakeThenStop("x", 6000));
							const sql = yield* SqlClient.SqlClient;
							const ended = yield* sql<{
								entry_json: string;
							}>`SELECT entry_json FROM run_ledger_entries WHERE session_id = 'w'
								AND event_sequence = (SELECT MAX(sequence) FROM events
									WHERE session_id = 'w' AND type = 'evidence.turn_ended')`;
							const fired = commit.committed();
							yield* TestClock.adjust(6000);
							yield* fired;
							return { ended, after: yield* observed };
						}),
					),
				(dir) =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
			).pipe(
				Effect.tap(({ ended, after }) =>
					Effect.sync(() => {
						// 6: the wake's turn_ended ended its work, not forced.
						expect(
							ended
								.map((row) => JSON.parse(row.entry_json))
								.find((entry) => entry.kind === "end"),
						).toMatchObject({
							outcome: "interrupted",
							reason: { tag: "interrupted", forced: false },
						});
						// Only x's unobserved wake is forced; w's deadline, passed, forced nothing.
						expect(after.forced).toEqual([{ session_id: "x" }]);
						expect(after.rows).toEqual([
							{ session_id: "w", alarm_at: null },
							{ session_id: "x", alarm_at: null },
						]);
					}),
				),
			),
	);
});
