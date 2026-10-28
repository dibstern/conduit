import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeRunnerReceiptStore,
	type RunnerRetirement,
} from "../../../src/lib/provider/runner/runner-receipts.js";

const testLayer = Layer.merge(
	makePersistenceEffectLayer(
		":memory:",
		"test-project",
		undefined,
		SessionEventBusLive,
	),
	SessionEventBusLive,
);

const retirement = {
	runnerId: "runner",
	sessionId: "session",
	driverKind: "cursor",
	pid: 123,
	startTime: "process-start",
	ownedRunIds: ["owned-run"],
	retiredAt: 100,
	signalled: true,
};

const decodedRetirement = {
	runnerId: "runner",
	sessionId: "session",
	driverKind: "cursor",
	identity: { tag: "Verified", pid: 123, startTime: "process-start" },
	ownedRunIds: ["owned-run"],
	retiredAt: 100,
	retirement: { tag: "Watching" },
	signal: { tag: "KillSent", members: [], sent: [] },
	reaper: undefined,
	members: [{ pid: 123, startTime: "process-start" }],
	signalLog: [],
	stopState: "Requested",
	stopReason: "Provider process stopped",
} satisfies RunnerRetirement;

const seedLegacy = (sql: SqlClient.SqlClient, signalled = true) =>
	sql`INSERT INTO claude_runner_cursors (runner_id, sequence, attachment_id, retired_at, session_id, pid, start_time, owned_run_ids, signalled, driver_kind)
	VALUES ('runner', 0, '', 100, 'session', 123, 'process-start', '["owned-run"]', ${signalled ? 1 : 0}, 'cursor')`;

// Release evidence and retirement must roll back together; nesting the old
// requestStop wrapper here would fail before reaching the projection handle.
it.effect("composes release and Stop mutation in the caller's one commit", () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const receipts = yield* makeRunnerReceiptStore(sql);
		const commit = yield* makeCommitAndSignal;
		yield* receipts.register("runner", retirement, "serving");
		yield* commit([
			canonicalEvent("session.created", "session", {
				sessionId: "session",
				title: "session",
				provider: "cursor",
			}),
		]);
		yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at, runner_id, held_transmission) VALUES ('held', 'session', 'running', 1, 'runner', 1)`;
		const release = canonicalEvent(
			"run.released",
			"session",
			{
				runId: "held",
				runnerId: "runner",
				commandId: "send",
				transmission: 1,
				reason: "Refused",
			},
			{ provider: "cursor", metadata: { runId: "held" } },
		);
		const write = commit.write((project) =>
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* project(yield* store.appendBatch([release]));
				return yield* receipts.requestStopMutation(decodedRetirement, {
					_tag: "Idle",
				});
			}),
		);
		yield* sql`CREATE TRIGGER reject_stop BEFORE UPDATE OF retired_at ON claude_runner_cursors BEGIN SELECT RAISE(ABORT, 'stop failed'); END`;
		expect((yield* Effect.result(write))._tag).toBe("Failure");
		expect(
			yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'held'`,
		).toEqual([{ runner_id: "runner", held_transmission: 1 }]);
		expect(
			yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.released'`,
		).toEqual([{ n: 0 }]);
		yield* sql`DROP TRIGGER reject_stop`;
		expect(yield* write).toMatchObject({
			runnerId: "runner",
			stopReason: '{"_tag":"Idle"}',
		});
		expect(
			yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'held'`,
		).toEqual([{ runner_id: null, held_transmission: null }]);
		expect(
			yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.released'`,
		).toEqual([{ n: 1 }]);
	}).pipe(Effect.provide(testLayer)),
);

// Swap failure cases: a held run or invalid successor refuses the whole commit;
// ordinary Stop cannot leave an unrecorded candidate behind; SQL failure rolls
// both role and retirement back. The Run Ledger remains the outcome writer.
it.effect(
	"swaps the serving row with retirement in one transaction, refusing held runs",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* receipts.register("runner", retirement, "serving");
			yield* receipts.register("candidate", retirement, "candidate");
			yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('session', 'test-project', 'cursor', 1, 1)`;
			yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at, runner_id) VALUES ('held', 'session', 'running', 1, 'runner')`;
			const reason = { _tag: "Superseded", successor: "candidate" } as const;
			expect(
				(yield* Effect.result(receipts.requestStop(decodedRetirement, reason)))
					._tag,
			).toBe("Failure");
			expect((yield* receipts.runners()).rows).toMatchObject([
				{ runnerId: "runner", role: "serving", retiredAt: null },
				{ runnerId: "candidate", role: "candidate", retiredAt: null },
			]);
			expect(
				yield* sql`SELECT status FROM provider_runs WHERE id = 'held'`,
			).toEqual([{ status: "running" }]);
			yield* sql`UPDATE provider_runs SET status = 'completed' WHERE id = 'held'`;
			yield* sql`CREATE TRIGGER reject_swap BEFORE UPDATE OF role ON claude_runner_cursors WHEN NEW.role = 'serving' BEGIN SELECT RAISE(ABORT, 'swap commit failed'); END`;
			expect(
				(yield* Effect.result(receipts.requestStop(decodedRetirement, reason)))
					._tag,
			).toBe("Failure");
			expect((yield* receipts.retirements()).rows).toEqual([]);
			yield* sql`DROP TRIGGER reject_swap`;
			yield* receipts.requestStop(decodedRetirement, reason);
			expect((yield* receipts.runners()).rows).toMatchObject([
				{ runnerId: "runner", retiredAt: 100 },
				{ runnerId: "candidate", role: "serving", retiredAt: null },
			]);
			expect(
				(yield* Effect.result(
					receipts.register("third", retirement, "serving"),
				))._tag,
			).toBe("Failure");
		}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"a serving Stop retires all candidates atomically and refuses missing snapshots",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* receipts.register("runner", retirement, "serving");
			yield* receipts.register("candidate", retirement, "candidate");
			expect(
				(yield* Effect.result(receipts.requestStop(decodedRetirement)))._tag,
			).toBe("Failure");
			expect((yield* receipts.retirements()).rows).toEqual([]);
			const candidate = {
				...decodedRetirement,
				runnerId: "candidate",
				members: [{ pid: 124, startTime: "candidate-start" }],
			};
			yield* receipts.requestStop(decodedRetirement, { _tag: "Explicit" }, [
				candidate,
			]);
			expect(
				(yield* receipts.runners()).rows.every((row) => row.retiredAt === 100),
			).toBe(true);
			expect((yield* receipts.retirements()).rows).toMatchObject([
				{ runnerId: "runner", stopReason: '{"_tag":"Explicit"}' },
				{
					runnerId: "candidate",
					stopReason: '{"_tag":"CandidateAbandoned"}',
					members: expect.arrayContaining([
						{ pid: 124, startTime: "candidate-start" },
					]),
				},
			]);
			expect(
				(yield* Effect.result(
					receipts.register("late-candidate", retirement, "candidate"),
				))._tag,
			).toBe("Failure");
			expect((yield* receipts.runners()).rows).toHaveLength(2);
		}).pipe(Effect.provide(testLayer)),
);

it.effect("decodes retirement identity, obligation and signal states", () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const receipts = yield* makeRunnerReceiptStore(sql);
		yield* seedLegacy(sql, false);
		expect((yield* receipts.retirements()).rows).toMatchObject([
			{
				identity: { tag: "Verified", pid: 123, startTime: "process-start" },
				retirement: { tag: "Watching" },
				signal: { tag: "None" },
			},
		]);
	}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"rejects malformed persisted retirement obligations with a typed error",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* seedLegacy(sql);
			for (const value of ["{", "[1]", '"run"']) {
				yield* sql`UPDATE claude_runner_cursors SET owned_run_ids = ${value}`;
				const result = yield* receipts.retirements();
				expect(result).toMatchObject({
					rows: [],
					rejected: [
						{ _tag: "RunnerRetirementDecodeError", runnerId: "runner" },
					],
				});
			}
		}).pipe(Effect.provide(testLayer)),
);

it.effect("retains an unsettled retirement when pruning is requested", () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const receipts = yield* makeRunnerReceiptStore(sql);
		yield* seedLegacy(sql);
		yield* receipts.markGone("runner");
		yield* receipts.pruneRetired("runner");
		expect((yield* receipts.retirements()).rows).toHaveLength(1);
	}).pipe(Effect.provide(testLayer)),
);

for (const status of ["pending", "running"] as const)
	it.effect(
		`retains a Gone retirement with a ${status} held run until settlement commits`,
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const receipts = yield* makeRunnerReceiptStore(sql);
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('session', 'test-project', 'cursor', 1, 1)`;
				yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at, runner_id) VALUES ('held-run', 'session', ${status}, 1, 'runner')`;
				const record = yield* receipts.requestStop({
					...decodedRetirement,
					ownedRunIds: [],
				});
				yield* receipts.stopProgress({ ...record, stopState: "Gone" });
				yield* receipts.markGone("runner");
				yield* receipts.settled("runner");
				yield* receipts.pruneRetired("runner");
				const retained = yield* receipts.retirements();
				expect(retained.rejected).toEqual([]);
				expect(retained.rows).toMatchObject([
					{ runnerId: "runner", stopState: "Gone", ownedRunIds: [] },
				]);
				expect(
					yield* sql`SELECT status, runner_id FROM provider_runs WHERE id = 'held-run'`,
				).toEqual([{ status, runner_id: "runner" }]);
				yield* sql`UPDATE provider_runs SET status = 'interrupted', completed_at = 2 WHERE id = 'held-run'`;
				yield* receipts.settled("runner");
				yield* receipts.stopProgress({ ...record, stopState: "Settled" });
				yield* receipts.pruneRetired("runner");
				expect((yield* receipts.retirements()).rows).toEqual([]);
			}).pipe(Effect.provide(testLayer)),
	);

it.effect(
	"upgrades populated cursors without retiring or losing their checkpoint",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE claude_runner_cursors (
			runner_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
			result_json TEXT NOT NULL DEFAULT '{}', attachment_id TEXT NOT NULL DEFAULT '')`;
			yield* sql`INSERT INTO claude_runner_cursors VALUES ('runner', 7, '{"children":[]}', 'old')`;
			const receipts = yield* makeRunnerReceiptStore(sql);
			expect(yield* receipts.attach("runner", "new", retirement)).toEqual({
				sequence: 7,
				result: { children: [] },
			});
			expect((yield* receipts.retirements()).rows).toEqual([]);
			expect(
				yield* sql`SELECT retired_at, pid, start_time, session_id, owned_run_ids, driver_kind FROM claude_runner_cursors`,
			).toEqual([
				{
					retired_at: null,
					pid: 123,
					start_time: "process-start",
					session_id: "session",
					owned_run_ids: "[]",
					driver_kind: "cursor",
				},
			]);
			yield* sql`UPDATE claude_runner_cursors SET owned_run_ids = '["legacy-run"]' WHERE runner_id = 'runner'`;
			yield* receipts.attach("runner", "newer", {
				...retirement,
				ownedRunIds: ["new-run"],
			});
			expect(
				yield* sql`SELECT owned_run_ids FROM claude_runner_cursors WHERE runner_id = 'runner'`,
			).toEqual([{ owned_run_ids: '["legacy-run"]' }]);
		}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"retirement is set-only and reconnect cannot revive its attachment",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* receipts.attach("runner", "old", retirement);
			const first = yield* receipts.requestStop(decodedRetirement);
			expect(first).toMatchObject({
				runnerId: "runner",
				retiredAt: 100,
				ownedRunIds: [],
				stopState: "Requested",
			});
			yield* receipts.attach("runner", "replacement", {
				...retirement,
				ownedRunIds: ["new-run"],
			});
			expect(
				yield* receipts.requestStop({ ...decodedRetirement, retiredAt: 200 }),
			).toEqual(first);
			expect((yield* receipts.retirements()).rows).toEqual([first]);
			expect(
				yield* sql`SELECT attachment_id, owned_run_ids FROM claude_runner_cursors`,
			).toEqual([{ attachment_id: "", owned_run_ids: "[]" }]);
			const gone = yield* receipts.requestStop({
				...decodedRetirement,
				runnerId: "gone",
			});
			yield* receipts.stopProgress({ ...gone, stopState: "Gone" });
			yield* receipts.markGone("gone");
			yield* receipts.settled("gone");
			yield* receipts.stopProgress({ ...gone, stopState: "Settled" });
			yield* receipts.pruneRetired("gone");
			expect((yield* receipts.retirements()).rows).toEqual([first]);
		}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"Stop waits for its transaction to commit while another writer holds SQL",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* receipts.attach("runner", "old", retirement);
			const writer = yield* makeCommitAndSignal;
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const held = yield* writer
				.write(() =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			yield* Effect.gen(function* () {
				const stop = yield* receipts
					.requestStop(decodedRetirement)
					.pipe(Effect.forkChild);
				yield* TestClock.adjust("5 seconds");
				expect(stop.pollUnsafe()).toBeUndefined();
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(held);
				const record = yield* Fiber.join(stop);
				expect(record).toMatchObject({
					runnerId: "runner",
					retiredAt: 100,
					ownedRunIds: [],
				});
				expect((yield* receipts.retirements()).rows).toEqual([record]);
			}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
		}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"a failed Stop COMMIT rolls back its fence and retries only on a new request",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* receipts.attach("runner", "old", retirement);
			yield* sql`CREATE TABLE stop_parent (id TEXT PRIMARY KEY)`;
			yield* sql`CREATE TABLE stop_commit_check (id TEXT REFERENCES stop_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
			yield* sql`CREATE TRIGGER reject_stop BEFORE INSERT ON claude_runner_cursors WHEN NEW.retired_at IS NOT NULL
		BEGIN INSERT INTO stop_commit_check VALUES ('missing'); END`;
			const failed = yield* Effect.exit(
				receipts.requestStop(decodedRetirement),
			);
			expect(failed._tag).toBe("Failure");
			expect((yield* receipts.retirements()).rows).toEqual([]);
			expect(
				yield* sql`SELECT retired_at, attachment_id, owned_run_ids FROM claude_runner_cursors`,
			).toEqual([
				{ retired_at: null, attachment_id: "old", owned_run_ids: "[]" },
			]);
			yield* sql`DROP TRIGGER reject_stop`;
			const writer = yield* makeCommitAndSignal;
			yield* writer.write(() => Effect.void);
			expect((yield* receipts.retirements()).rows).toEqual([]);
			const record = yield* receipts.requestStop(decodedRetirement);
			expect((yield* receipts.retirements()).rows).toEqual([record]);
		}).pipe(Effect.provide(testLayer)),
);
