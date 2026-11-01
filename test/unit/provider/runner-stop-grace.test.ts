import { it } from "@effect/vitest";
import { Clock, Data, Effect, Exit, Fiber, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	makeRunnerReceiptStore,
	type RunnerRetirement,
} from "../../../src/lib/provider/runner/runner-receipts.js";
import { makeRunnerStopReconciler } from "../../../src/lib/provider/runner/runner-retirement.js";

// Failure cases: shutdown consumes part of the grace; the Stop waiter blocks
// beyond its bound; restart discards the remaining grace; old logs stop decoding.
class RefusedSignal extends Data.TaggedError("RefusedSignal")<{
	readonly code: "EPERM";
}> {}

for (const restart of [false, true])
	for (const refused of [false, true])
		it.effect(
			`keeps three seconds after TERM while bounding the Stop waiter, restart=${restart}, refused=${refused}`,
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const receipts = yield* makeRunnerReceiptStore(sql);
						const clock = yield* Clock.Clock;
						const signals: Array<{ signal: string; at: number }> = [];
						const record: RunnerRetirement = {
							runnerId: "runner",
							sessionId: "session",
							driverKind: "claude",
							identity: { tag: "Verified", pid: 123, startTime: "started" },
							reaper: undefined,
							members: [],
							signalLog: [],
							signal: { tag: "None" },
							retirement: { tag: "Watching" },
							ownedRunIds: [],
							retiredAt: 0,
						};
						const options = {
							receipts,
							processTable: {
								inspect: () => ({
									state: "running",
									startTime: "started",
									pgid: 123,
								}),
								signal: (_pid: number, signal: NodeJS.Signals | 0) => {
									signals.push({
										signal: String(signal),
										at: clock.currentTimeMillisUnsafe(),
									});
									if (refused && signal === "SIGTERM")
										throw new RefusedSignal({ code: "EPERM" });
								},
							},
							committed: () => Effect.void,
							shutdown: () => Effect.never,
							evict: () => Effect.void,
							prune: () => Effect.void,
							notice: () => Effect.succeed(false),
						} satisfies Parameters<typeof makeRunnerStopReconciler>[0];
						let owner = yield* Scope.make();
						yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
						let reconciler = yield* makeRunnerStopReconciler(options).pipe(
							Effect.provideService(Scope.Scope, owner),
						);
						yield* reconciler.register(
							"runner",
							{ sessionId: "session", pid: 123, startTime: "started" },
							"serving",
						);
						yield* reconciler.requestStop(record);
						yield* TestClock.adjust("1 second");
						expect(signals).toEqual([{ signal: "SIGTERM", at: 1_000 }]);
						if (restart) {
							yield* Scope.close(owner, Exit.void);
							owner = yield* Scope.make();
							reconciler = yield* makeRunnerStopReconciler(options).pipe(
								Effect.provideService(Scope.Scope, owner),
							);
							yield* reconciler.recover();
						}
						const waiter = yield* Effect.forkChild(
							reconciler.awaitStop("runner", "Escalated"),
						);
						yield* TestClock.adjust("2 seconds");
						expect(signals).toEqual([{ signal: "SIGTERM", at: 1_000 }]);
						yield* TestClock.adjust("1 second");
						yield* Fiber.join(waiter);
						expect(signals).toEqual([
							{ signal: "SIGTERM", at: 1_000 },
							{ signal: "SIGKILL", at: 4_000 },
						]);
					}),
				).pipe(
					Effect.provide(makePersistenceEffectLayer(":memory:", "project")),
				),
		);

// A crash can leave Escalating durable before its first signal was attempted.
for (const previousUntimedTerm of [false, true])
	it.effect(
		`recovery grants full TERM grace, previous untimed attempt=${previousUntimedTerm}`,
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const receipts = yield* makeRunnerReceiptStore(sql);
					const clock = yield* Clock.Clock;
					const signals: Array<{ signal: string; at: number }> = [];
					const commit = yield* receipts.requestStop({
						runnerId: "runner",
						sessionId: "session",
						driverKind: "claude",
						identity: { tag: "Verified", pid: 123, startTime: "started" },
						reaper: undefined,
						members: [],
					});
					const record =
						commit._tag === "Requested"
							? commit.record
							: expect.unreachable("Ignored");
					yield* receipts.stopProgress({
						...record,
						stopState: "Escalating",
						stopStartedAt: 0,
					});
					if (previousUntimedTerm)
						yield* receipts.appendSignalLog(
							"runner",
							[
								{
									signal: "SIGTERM",
									target: -123,
									members: [{ pid: 123, startTime: "started" }],
									outcome: "delivered",
								},
							],
							{
								tag: "TermSent",
								members: [{ pid: 123, startTime: "started" }],
							},
						);
					yield* TestClock.adjust("10 seconds");
					const reconciler = yield* makeRunnerStopReconciler({
						receipts,
						processTable: {
							inspect: () => ({
								state: "running",
								startTime: "started",
								pgid: 123,
							}),
							signal: (_pid, signal) => {
								signals.push({
									signal: String(signal),
									at: clock.currentTimeMillisUnsafe(),
								});
							},
						},
						committed: () => Effect.void,
						shutdown: () => Effect.void,
						evict: () => Effect.void,
						prune: () => Effect.void,
						notice: () => Effect.succeed(false),
					});
					yield* reconciler.recover();
					yield* TestClock.adjust("0 millis");
					expect(signals).toEqual([{ signal: "SIGTERM", at: 10_000 }]);
					yield* TestClock.adjust("2999 millis");
					expect(signals).toEqual([{ signal: "SIGTERM", at: 10_000 }]);
					yield* TestClock.adjust("1 millis");
					expect(signals).toEqual([
						{ signal: "SIGTERM", at: 10_000 },
						{ signal: "SIGKILL", at: 13_000 },
					]);
				}),
			).pipe(Effect.provide(makePersistenceEffectLayer(":memory:", "project"))),
	);

it.effect(
	"signal-log recovery retries the retained attempt without sending TERM again",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const receipts = yield* makeRunnerReceiptStore(sql);
				const clock = yield* Clock.Clock;
				const signals: Array<{ signal: string; at: number }> = [];
				const reconciler = yield* makeRunnerStopReconciler({
					receipts,
					processTable: {
						inspect: () => ({
							state: "running",
							startTime: "started",
							pgid: 123,
						}),
						signal: (_pid, signal) => {
							signals.push({
								signal: String(signal),
								at: clock.currentTimeMillisUnsafe(),
							});
						},
					},
					committed: () => Effect.void,
					shutdown: () => Effect.void,
					evict: () => Effect.void,
					prune: () => Effect.void,
					notice: () => Effect.succeed(false),
				});
				yield* reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"serving",
				);
				yield* sql`CREATE TRIGGER reject_signal_log BEFORE UPDATE OF signal_log ON claude_runner_cursors BEGIN SELECT RAISE(ABORT, 'signal log temporarily unavailable'); END`;
				yield* reconciler.requestStop({
					runnerId: "runner",
					sessionId: "session",
					driverKind: "claude",
					identity: { tag: "Verified", pid: 123, startTime: "started" },
					reaper: undefined,
					members: [],
				});
				yield* TestClock.adjust("0 millis");
				expect(signals).toEqual([{ signal: "SIGTERM", at: 0 }]);
				expect((yield* receipts.retirements()).rows[0]?.signalLog).toEqual([]);
				yield* sql`DROP TRIGGER reject_signal_log`;
				yield* TestClock.adjust("1 second");
				expect(
					(yield* receipts.retirements()).rows[0]?.signalLog,
				).toMatchObject([{ signal: "SIGTERM", at: 0 }]);
				expect(signals).toEqual([{ signal: "SIGTERM", at: 0 }]);
			}),
		).pipe(Effect.provide(makePersistenceEffectLayer(":memory:", "project"))),
);

it.effect(
	"the Stop waiter stays bounded while durable signal logging keeps retrying",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const receipts = yield* makeRunnerReceiptStore(sql);
				let gone = false;
				const reconciler = yield* makeRunnerStopReconciler({
					receipts,
					processTable: {
						inspect: () =>
							gone
								? { state: "gone" }
								: { state: "running", startTime: "started", pgid: 123 },
						signal: () => undefined,
					},
					committed: () => Effect.void,
					shutdown: () => Effect.void,
					// No session row is left, so Settle has nothing to end.
					settlement: {
						sql,
						configDir: "unused",
						driverKind: "claude",
						closeSends: () => Effect.void,
						entry: () => undefined,
						ingestion: () => Effect.succeed(undefined),
						projectRoot: () => Effect.succeed(undefined),
						commit: () => Effect.void,
						wake: () => Effect.void,
					},
					evict: () => Effect.void,
					prune: () => Effect.void,
					notice: () => Effect.succeed(false),
				});
				yield* reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"serving",
				);
				yield* sql`CREATE TRIGGER reject_signal_log BEFORE UPDATE OF signal_log ON claude_runner_cursors BEGIN SELECT RAISE(ABORT, 'signal log temporarily unavailable'); END`;
				yield* reconciler.requestStop({
					runnerId: "runner",
					sessionId: "session",
					driverKind: "claude",
					identity: { tag: "Verified", pid: 123, startTime: "started" },
					reaper: undefined,
					members: [],
				});
				const escalated = yield* reconciler
					.awaitStop("runner", "Escalated")
					.pipe(Effect.forkChild);
				const settled = yield* reconciler
					.awaitStop("runner", "Settled")
					.pipe(Effect.forkChild);
				yield* TestClock.adjust("4 seconds");
				expect(escalated.pollUnsafe()?._tag).toBe("Success");
				expect(settled.pollUnsafe()).toBeUndefined();
				gone = true;
				yield* sql`DROP TRIGGER reject_signal_log`;
				yield* TestClock.adjust("60 seconds");
				expect(settled.pollUnsafe()?._tag).toBe("Success");
			}),
		).pipe(Effect.provide(makePersistenceEffectLayer(":memory:", "project"))),
);
