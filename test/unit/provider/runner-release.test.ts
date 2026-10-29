import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeRunnerReceiptStore,
	type RunnerRetirement,
} from "../../../src/lib/provider/runner/runner-receipts.js";
import {
	makeRunnerRunLifecycle,
	makeRunnerStopReconciler,
	type RunRelease,
} from "../../../src/lib/provider/runner/runner-retirement.js";

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
	retiredAt: 1,
};
const release: RunRelease = {
	sessionId: "session",
	runId: "run",
	runnerId: "runner",
	commandId: "send",
	transmission: 1,
	reason: "Refused",
	refusalReason: "exiting",
};
const layer = makePersistenceEffectLayer(":memory:", "project");

// Refusal commits must preserve the continuation handle before revocation;
// failed commits must leave both Stop and release eligible for a new attempt.
it.effect(
	"release preserves the live handle before Stop cleanup and joins racing Stops",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const receipts = yield* makeRunnerReceiptStore(sql);
				const entered = yield* Deferred.make<void>();
				const proceed = yield* Deferred.make<void>();
				const actions: string[] = [];
				let commits = 0;
				const reconciler = yield* makeRunnerStopReconciler({
					receipts,
					processTable: {
						inspect: () => ({
							state: "running",
							startTime: "started",
							pgid: 123,
						}),
						signal: () => undefined,
					},
					release: (_input, stop) =>
						Effect.gen(function* () {
							commits++;
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(proceed);
							// The serving row this transaction read is the stopped runner.
							const result = yield* sql.withTransaction(
								stop ? stop(record) : Effect.succeed(undefined),
							);
							actions.push("commit");
							return { released: true, stop: result };
						}).pipe(Effect.orDie),
					released: () =>
						Effect.sync(() => {
							actions.push("requeue");
						}),
					committed: () =>
						Effect.sync(() => {
							actions.push("cleanup");
						}),
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
				const releasing = yield* reconciler
					.release(release)
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				expect(reconciler.state("runner")._tag).toBe("Committing");
				const stopping = yield* reconciler
					.requestStop(record)
					.pipe(Effect.forkChild);
				yield* Effect.yieldNow;
				yield* Deferred.succeed(proceed, undefined);
				yield* Fiber.join(releasing);
				yield* Fiber.join(stopping);
				expect(commits).toBe(1);
				expect(actions.slice(0, 3)).toEqual(["commit", "requeue", "cleanup"]);
				expect(reconciler.serving("session")).toBeUndefined();
				expect((yield* receipts.retirements()).rows).toMatchObject([
					{ stopReason: '{"_tag":"Idle"}' },
				]);
			}),
		).pipe(Effect.provide(layer)),
);

it.effect(
	"a release that finds no serving row clears Committing and wakes a racing explicit Stop",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const receipts = yield* makeRunnerReceiptStore(sql);
				const entered = yield* Deferred.make<void>();
				const proceed = yield* Deferred.make<void>();
				const reconciler = yield* makeRunnerStopReconciler({
					receipts,
					processTable: {
						inspect: () => ({ state: "gone" }),
						signal: () => undefined,
					},
					release: () =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(proceed)),
							Effect.as({ released: true }),
						),
					released: () => Effect.void,
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
				const releasing = yield* reconciler
					.release(release)
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				const stopping = yield* reconciler
					.requestStop(record)
					.pipe(Effect.forkChild);
				yield* Effect.yieldNow;
				yield* Deferred.succeed(proceed, undefined);
				yield* Fiber.join(releasing);
				yield* Fiber.join(stopping);
				expect((yield* receipts.retirements()).rows).toMatchObject([
					{ stopReason: '{"_tag":"Explicit"}' },
				]);
				expect(reconciler.state("runner")._tag).not.toBe("Committing");
			}),
		).pipe(Effect.provide(layer)),
);

it.effect(
	"a stale release never requeues the send or stops its current serving runner",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const receipts = yield* makeRunnerReceiptStore(sql);
				const actions: string[] = [];
				const reconciler = yield* makeRunnerStopReconciler({
					receipts,
					processTable: {
						inspect: () => ({
							state: "running",
							startTime: "started",
							pgid: 123,
						}),
						signal: () => {
							actions.push("signal");
						},
					},
					release: () => Effect.succeed({ released: false }),
					released: () =>
						Effect.sync(() => {
							actions.push("requeue");
						}),
					committed: () =>
						Effect.sync(() => {
							actions.push("cleanup");
						}),
					shutdown: () =>
						Effect.sync(() => {
							actions.push("shutdown");
						}),
					evict: () => Effect.void,
					prune: () => Effect.void,
					notice: () => Effect.succeed(false),
				});
				yield* reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"serving",
				);
				yield* reconciler.release(release);
				expect(actions).toEqual([]);
				expect(reconciler.state("runner")).toEqual({ _tag: "Running" });
				expect(reconciler.serving("session")).toBe("runner");
				expect((yield* receipts.retirements()).rows).toEqual([]);
			}),
		).pipe(Effect.provide(layer)),
);

// Durable role changes need not have populated this reconciler's route cache.
for (const cached of ["missing", "candidate"])
	it.effect(
		`refusal stops the SQL serving runner with ${cached} cached role`,
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const receipts = yield* makeRunnerReceiptStore(sql);
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("session.created", "session", {
							sessionId: "session",
							title: "session",
							provider: "claude",
						}),
						canonicalEvent(
							"run.requested",
							"session",
							{ runId: "run", inputId: "run" },
							{ provider: "claude", metadata: { runId: "run" } },
						),
					]);
					const lifecycle = makeRunnerRunLifecycle({
						sql,
						commit,
						eventStore: yield* EventStoreEffectTag,
					});
					const reconciler = yield* makeRunnerStopReconciler({
						receipts,
						processTable: {
							inspect: () => ({
								state: "running",
								startTime: "started",
								pgid: 123,
							}),
							signal: () => undefined,
						},
						release: (input, stop) =>
							lifecycle
								.releaseRun(input, stop ?? (() => Effect.succeed(undefined)))
								.pipe(Effect.orDie),
						released: () => Effect.void,
						committed: () => Effect.void,
						shutdown: () => Effect.void,
						evict: () => Effect.void,
						prune: () => Effect.void,
						notice: () => Effect.succeed(false),
					});
					if (cached === "candidate") {
						yield* reconciler.register(
							"predecessor",
							{ sessionId: "session", pid: 124, startTime: "started" },
							"serving",
						);
						yield* reconciler.register(
							"runner",
							{ sessionId: "session", pid: 123, startTime: "started" },
							"candidate",
						);
						yield* sql`UPDATE claude_runner_cursors SET retired_at = 1 WHERE runner_id = 'predecessor'`;
						yield* sql`UPDATE claude_runner_cursors SET role = 'serving' WHERE runner_id = 'runner'`;
					} else {
						yield* receipts.register(
							"runner",
							{ sessionId: "session", pid: 123, startTime: "started" },
							"serving",
						);
					}
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at) VALUES (1, 'send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1)`;
					yield* lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
					});
					yield* reconciler.release(release);
					expect((yield* receipts.retirements(["runner"])).rows).toMatchObject([
						{ runnerId: "runner", stopReason: '{"_tag":"Idle"}' },
					]);
					expect(
						yield* sql`SELECT runner_id FROM claude_runner_cursors WHERE session_id = 'session' AND role = 'serving' AND retired_at IS NULL`,
					).toEqual([]);
					expect(
						yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
					).toEqual([{ runner_id: null, held_transmission: null }]);
					expect(
						yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.released'`,
					).toEqual([{ n: 1 }]);
					expect(reconciler.serving("session")).toBeUndefined();
				}),
			).pipe(Effect.provide(layer)),
	);

it.effect(
	"a repeated swap Stop checks its winner in SQL after the serving row changes",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const receipts = yield* makeRunnerReceiptStore(sql);
				const reconciler = yield* makeRunnerStopReconciler({
					receipts,
					processTable: {
						inspect: () => ({
							state: "running",
							startTime: "started",
							pgid: 123,
						}),
						signal: () => undefined,
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
				yield* reconciler.register(
					"successor",
					{ sessionId: "session", pid: 124, startTime: "started" },
					"candidate",
				);
				const reason = { _tag: "Superseded", successor: "successor" } as const;
				yield* reconciler.requestStop(record, reason);
				yield* sql`UPDATE claude_runner_cursors SET retired_at = 2 WHERE runner_id = 'successor'`;
				expect(
					(yield* Effect.result(reconciler.requestStop(record, reason)))._tag,
				).toBe("Failure");
			}),
		).pipe(Effect.provide(layer)),
);
