import { it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Scheduler,
	Tracer,
} from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	currentCommitGuard,
	flushRunnerRetirements,
	hasPendingRunnerRetirement,
	makeCommitAndSignal,
	queueRunnerRetirement,
} from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";

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
			expect(yield* receipts.retirements()).toEqual([]);
			expect(
				yield* sql`SELECT retired_at, pid, start_time, session_id, owned_run_ids, driver_kind FROM claude_runner_cursors`,
			).toEqual([
				{
					retired_at: null,
					pid: 123,
					start_time: "process-start",
					session_id: "session",
					owned_run_ids: '["owned-run"]',
					driver_kind: "cursor",
				},
			]);
		}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"retirement is set-only and reconnect cannot revive the attachment",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* receipts.attach("runner", "old", retirement);
			yield* receipts.retire(retirement);
			yield* flushRunnerRetirements(sql);
			yield* receipts.attach("runner", "replacement");
			yield* receipts.retire({ ...retirement, retiredAt: 200 });
			yield* flushRunnerRetirements(sql);
			expect(yield* receipts.retirements()).toEqual([retirement]);
			expect(
				yield* sql`SELECT attachment_id FROM claude_runner_cursors`,
			).toEqual([{ attachment_id: "" }]);
			queueRunnerRetirement(sql, { ...retirement, runnerId: "gone" });
			yield* receipts.pruneRetired("gone");
			yield* flushRunnerRetirements(sql);
			expect(yield* receipts.retirements()).toEqual([retirement]);
		}).pipe(Effect.provide(testLayer)),
);

it.live(
	"queues retirement and releases admission while a seam transaction holds SQL",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* receipts.attach("runner", "old", retirement);
			const writer = yield* makeCommitAndSignal;
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const write = yield* writer
				.write(() =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			let admissionReleased = false;
			const started = performance.now();
			yield* Effect.suspend(() => receipts.retire(retirement)).pipe(
				Effect.andThen(
					Effect.sync(() => {
						admissionReleased = true;
					}),
				),
				Effect.timeout("200 millis"),
				Effect.ensuring(Deferred.succeed(release, undefined)),
			);
			expect(admissionReleased).toBe(true);
			expect(performance.now() - started).toBeLessThan(200);
			yield* Fiber.join(write);
			expect(yield* receipts.retirements()).toEqual([retirement]);
		}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"the final hook persists queued tombstones and a rollback keeps them pending",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* receipts.attach("runner", "old", retirement);
			const writer = yield* makeCommitAndSignal;
			queueRunnerRetirement(sql, retirement);
			expect(hasPendingRunnerRetirement(sql, "session", "owned-run")).toBe(
				true,
			);
			expect(
				hasPendingRunnerRetirement(sql, "other-session", "owned-run"),
			).toBe(false);
			expect(hasPendingRunnerRetirement(sql, "session", "other-run")).toBe(
				false,
			);
			// A deferred constraint fails COMMIT after the flush's UPDATE succeeded.
			// Removing the queue on UPDATE would lose this retirement on rollback.
			yield* sql`CREATE TABLE retirement_parent (id TEXT PRIMARY KEY)`;
			yield* sql`CREATE TABLE retirement_commit_check (
			runner_id TEXT REFERENCES retirement_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
			yield* sql`CREATE TRIGGER reject_retirement AFTER UPDATE OF retired_at ON claude_runner_cursors
			BEGIN INSERT INTO retirement_commit_check VALUES ('missing'); END`;
			const failed = yield* Effect.exit(writer.write(() => Effect.void));
			expect(failed._tag).toBe("Failure");
			expect(yield* receipts.retirements()).toEqual([]);
			yield* sql`DROP TRIGGER reject_retirement`;
			yield* writer.write(() => Effect.void);
			expect(yield* receipts.retirements()).toEqual([retirement]);
			expect(hasPendingRunnerRetirement(sql, "session", "owned-run")).toBe(
				false,
			);
		}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"flushes after the retained f4 commit guard and isolates SQL clients",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* receipts.attach("runner", "old", retirement);
			const writer = yield* makeCommitAndSignal;
			queueRunnerRetirement(sql, retirement);
			yield* Effect.gen(function* () {
				const otherSql = yield* SqlClient.SqlClient;
				const otherReceipts = yield* makeRunnerReceiptStore(otherSql);
				const otherWriter = yield* makeCommitAndSignal;
				yield* otherWriter.write(() => Effect.void);
				expect(yield* otherReceipts.retirements()).toEqual([]);
			}).pipe(Effect.provide(testLayer, { local: true }));
			expect(yield* receipts.retirements()).toEqual([]);
			yield* writer
				.write(() => Effect.void)
				.pipe(
					Effect.provideService(
						currentCommitGuard,
						Effect.sync(() => queueRunnerRetirement(sql, retirement)),
					),
				);
			expect(yield* receipts.retirements()).toEqual([retirement]);
		}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"a detached retirement opens its own transaction after its caller rolls back",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* receipts.attach("runner", "old", retirement);
			const writer = yield* makeCommitAndSignal;
			const originalTransaction = sql.withTransaction;
			const depths: Array<number | undefined> = [];
			const transactionSpy = vi
				.spyOn(sql, "withTransaction")
				.mockImplementation(<A, E, R>(body: Effect.Effect<A, E, R>) =>
					Effect.gen(function* () {
						const ambient = yield* Effect.serviceOption(sql.transactionService);
						depths.push(Option.getOrUndefined(ambient)?.[1]);
						return yield* originalTransaction(body);
					}),
				);
			yield* Effect.gen(function* () {
				yield* Effect.exit(
					writer.write(() =>
						receipts
							.retire(retirement)
							.pipe(
								Effect.andThen(Effect.yieldNow),
								Effect.andThen(Effect.fail("roll back caller")),
							),
					),
				);
				yield* flushRunnerRetirements(sql);
				yield* TestClock.adjust("1 millis");
				expect(depths.length).toBe(3);
				expect(depths.every((depth) => depth === undefined)).toBe(true);
				expect(yield* receipts.retirements()).toEqual([retirement]);
			}).pipe(Effect.ensuring(Effect.sync(() => transactionSpy.mockRestore())));
		}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"cannot yield to a revocation between its final hook and COMMIT",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const receipts = yield* makeRunnerReceiptStore(sql);
			yield* receipts.attach("runner", "old", retirement);
			const writer = yield* makeCommitAndSignal;
			yield* writer.write(() => Effect.void);
			const scheduler = yield* Scheduler.Scheduler;
			let commitCheckpoint = false;
			let committed = false;
			let revoked = false;
			const tracer = Tracer.make({
				span: ({ name, parent, annotations, links, startTime, kind }) => ({
					_tag: "Span",
					name,
					parent,
					annotations,
					links,
					kind,
					spanId: "commit-checkpoint",
					traceId: "commit-checkpoint",
					status: { _tag: "Started", startTime },
					attributes: new Map(),
					sampled: true,
					end: () => {
						if (name === "sql.transaction" && commitCheckpoint)
							committed = true;
					},
					attribute: () => {},
					addLinks: () => {},
					event: (event) => {
						if (event === "effect.sql.transaction.commit")
							commitCheckpoint = true;
					},
				}),
			});
			yield* writer
				.write(() => Effect.void)
				.pipe(
					Effect.withTracer(tracer),
					Effect.provideService(Scheduler.Scheduler, {
						executionMode: scheduler.executionMode,
						makeDispatcher: () => scheduler.makeDispatcher(),
						shouldYield: (fiber) => {
							if (commitCheckpoint && !committed && !revoked) {
								revoked = true;
								queueRunnerRetirement(sql, retirement);
								return true;
							}
							return scheduler.shouldYield(fiber);
						},
					}),
				);
			expect(commitCheckpoint).toBe(true);
			// A scheduler opportunity represents another fiber synchronously revoking.
			// If it happens before COMMIT, that same COMMIT must contain the tombstone.
			expect(!revoked || (yield* receipts.retirements()).length === 1).toBe(
				true,
			);
		}).pipe(Effect.provide(testLayer)),
);
