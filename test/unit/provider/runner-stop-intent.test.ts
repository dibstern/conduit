import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Logger, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	makeRunnerReceiptStore,
	type StopTarget,
} from "../../../src/lib/provider/runner/runner-receipts.js";
import { makeRunnerStopReconciler } from "../../../src/lib/provider/runner/runner-retirement.js";
import { makeTestProcessTable } from "../../helpers/runner-process-table.js";

// Failure cases: Stop imports a caller's snapshot; shutdown outruns a pending
// observation/commit; unknown membership stalls forever; recovery reads per row.
const target: StopTarget = {
	runnerId: "runner",
	sessionId: "session",
	driverKind: "claude",
	identity: { tag: "Verified", pid: 123, startTime: "started" },
	reaper: undefined,
	members: [],
};

it.effect(
	"Stop records intent without taking ownership of caller membership",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const receipts = yield* makeRunnerReceiptStore(sql);
				const result = yield* receipts.requestStop({
					...target,
					members: [{ pid: 456, startTime: "caller-snapshot" }],
				});
				expect(result._tag).toBe("Requested");
				expect(
					yield* sql`SELECT member_snapshot FROM claude_runner_cursors`,
				).toEqual([{ member_snapshot: "[]" }]);
			}),
		).pipe(Effect.provide(makePersistenceEffectLayer(":memory:", "project"))),
);

// A short-lived owner must not cancel its watcher at the fallback's deadline.
it.effect(
	"a scoped Stop waits for unverified shutdown and leaves Requested before returning",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const receipts = yield* makeRunnerReceiptStore(sql);
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				let shutdowns = 0;
				const stopping = yield* Effect.scoped(
					Effect.gen(function* () {
						const reconciler = yield* makeRunnerStopReconciler({
							receipts,
							processTable: makeTestProcessTable({
								processes: new Map([[123, { state: "unknown" }]]),
							}),
							committed: () => Effect.void,
							shutdown: () =>
								Effect.gen(function* () {
									shutdowns++;
									yield* Deferred.succeed(entered, undefined);
									yield* Deferred.await(release);
								}),
							evict: () => Effect.void,
							prune: () => Effect.void,
							notice: () => Effect.succeed(false),
						});
						yield* reconciler.requestStop(target);
						yield* reconciler.awaitStop("runner", "Escalated");
						return (yield* receipts.retirements()).rows[0]?.stopState;
					}),
				).pipe(Effect.forkChild);
				yield* TestClock.adjust("4 seconds");
				expect(stopping.pollUnsafe()).toBeUndefined();
				yield* Deferred.await(entered);
				yield* Deferred.succeed(release, undefined);
				expect(yield* Fiber.join(stopping)).toMatch(/^(Escalating|Escalated)$/);
				expect(shutdowns).toBe(1);
			}),
		).pipe(Effect.provide(makePersistenceEffectLayer(":memory:", "project"))),
);

it.effect(
	"a Requested Stop whose watcher is gone fails within one further Stop window",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const receipts = yield* makeRunnerReceiptStore(sql);
				const owner = yield* Scope.make();
				yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
				const reconciler = yield* makeRunnerStopReconciler({
					receipts,
					processTable: makeTestProcessTable({
						processes: new Map([[123, { state: "unknown" }]]),
					}),
					committed: () => Effect.void,
					shutdown: () => Effect.void,
					evict: () => Effect.void,
					prune: () => Effect.void,
					notice: () => Effect.succeed(false),
				}).pipe(Effect.provideService(Scope.Scope, owner));
				yield* reconciler.requestStop(target);
				yield* TestClock.adjust("0 millis");
				yield* Scope.close(owner, Exit.void);
				const stopping = yield* reconciler
					.awaitStop("runner", "Escalated")
					.pipe(Effect.result, Effect.forkChild);
				yield* TestClock.adjust("4 seconds");
				expect(stopping.pollUnsafe()).toBeUndefined();
				yield* TestClock.adjust("4 seconds");
				const result = yield* Fiber.join(stopping);
				expect(result).toMatchObject({
					_tag: "Failure",
					failure: { code: "runner_stop_timeout" },
				});
				expect((yield* receipts.retirements()).rows[0]?.stopState).toBe(
					"Requested",
				);
			}),
		).pipe(Effect.provide(makePersistenceEffectLayer(":memory:", "project"))),
);

it.effect(
	"Requested commits membership before shutdown and sends no early signal",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const receipts = yield* makeRunnerReceiptStore(sql);
				const gate = yield* Deferred.make<void>();
				const entered = yield* Deferred.make<void>();
				const shutdown = yield* Deferred.make<void>();
				const memory = makeTestProcessTable({
					processes: new Map([
						[123, { state: "running", startTime: "started", pgid: 123 }],
						[456, { state: "running", startTime: "grandchild", pgid: 123 }],
					]),
				});
				const reconciler = yield* makeRunnerStopReconciler({
					receipts,
					processTable: {
						...memory,
						observe: (query) =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(gate)),
								Effect.andThen(memory.observe(query)),
							),
					},
					committed: () => Effect.void,
					shutdown: () =>
						Effect.gen(function* () {
							expect(
								(yield* receipts.retirements()).rows[0]?.members,
							).toContainEqual({ pid: 456, startTime: "grandchild" });
							expect(memory.calls.signals).toEqual([]);
							yield* Deferred.succeed(shutdown, undefined);
						}),
					evict: () => Effect.void,
					prune: () => Effect.void,
					notice: () => Effect.succeed(false),
				});
				yield* reconciler.requestStop(target);
				yield* Deferred.await(entered);
				expect(reconciler.state("runner")._tag).toBe("Requested");
				expect(
					yield* sql`SELECT member_snapshot FROM claude_runner_cursors`,
				).toEqual([{ member_snapshot: "[]" }]);
				yield* Deferred.succeed(gate, undefined);
				yield* Deferred.await(shutdown);
			}),
		).pipe(Effect.provide(makePersistenceEffectLayer(":memory:", "project"))),
);

it.effect(
	"unknown membership retries until the stored grace ends, then logs and finishes Stop",
	() => {
		const warnings: string[] = [];
		return Effect.scoped(
			Effect.gen(function* () {
				const receipts = yield* makeRunnerReceiptStore(
					yield* SqlClient.SqlClient,
				);
				yield* receipts.requestStop(target);
				yield* TestClock.adjust("3 seconds");
				const shutdowns: number[] = [];
				const memory = makeTestProcessTable({
					processes: new Map([[123, { state: "unknown" }]]),
				});
				const reconciler = yield* makeRunnerStopReconciler({
					receipts,
					processTable: memory,
					committed: () => Effect.void,
					shutdown: () =>
						Effect.sync(() => {
							shutdowns.push(1);
						}),
					evict: () => Effect.void,
					prune: () => Effect.void,
					notice: () => Effect.succeed(false),
				});
				yield* reconciler.recover();
				yield* TestClock.adjust("0 millis");
				expect(shutdowns).toEqual([]);
				expect(reconciler.state("runner")._tag).toBe("Requested");
				yield* TestClock.adjust("999 millis");
				expect(shutdowns).toEqual([]);
				yield* TestClock.adjust("1 millis");
				yield* reconciler.awaitStop("runner", "Escalated");
				expect(shutdowns).toEqual([1]);
				expect(
					warnings.filter((line) => line.includes("membership unverified")),
				).toHaveLength(1);
				expect(memory.calls.signals).toEqual([]);
			}),
		).pipe(
			Effect.provide(makePersistenceEffectLayer(":memory:", "project")),
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						warnings.push(String(options.message));
					}),
				]),
			),
		);
	},
);
