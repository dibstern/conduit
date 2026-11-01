import { it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import {
	type CommitAndSignal,
	makeCommitAndSignal,
} from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { RunRelease } from "../../../src/lib/provider/runner/process-runner-types.js";
import {
	makeRunnerReceiptStore,
	type RunnerRetirement,
} from "../../../src/lib/provider/runner/runner-receipts.js";
import {
	makeRunnerRunLifecycle,
	makeRunnerStopReconciler,
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
				// An interrupted refusal names no leaving runner.
				yield* reconciler.release({ ...release, refusalReason: "interrupted" });
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
						release: (input) => lifecycle.releaseRun(input).pipe(Effect.orDie),
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

// A hold whose transaction rolls back after its body set the current hold must
// not leave that uncommitted transmission current.
it.effect("a rolled-back hold leaves no current hold", () =>
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
			yield* receipts.register(
				"runner",
				{ sessionId: "session", pid: 123, startTime: "started" },
				"serving",
			);
			yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at) VALUES (1, 'send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1)`;
			const current = new Set<number>();
			// The body succeeds, then a later statement in its transaction fails.
			const write: CommitAndSignal["write"] = (body, writeOptions) =>
				commit.write(
					(project, stamp) =>
						body(project, stamp).pipe(
							Effect.tap(() => sql`SELECT missing FROM rolled_back`),
						),
					writeOptions,
				);
			const lifecycle = makeRunnerRunLifecycle({
				sql,
				commit: Object.assign(
					(events: Parameters<CommitAndSignal>[0]) => commit(events),
					{ committed: commit.committed, write },
				),
				eventStore: yield* EventStoreEffectTag,
				holds: {
					held: (_run, _runner, transmission) => {
						current.add(transmission);
						return () => current.delete(transmission);
					},
					released: () => Effect.void,
				},
			});
			const held = yield* Effect.exit(
				lifecycle.holdRun({
					sessionId: "session",
					runId: "run",
					commandId: "send",
				}),
			);
			expect(held._tag).toBe("Failure");
			expect(
				yield* sql`SELECT held_transmission FROM provider_runs WHERE id = 'run'`,
			).toEqual([{ held_transmission: null }]);
			expect([...current]).toEqual([]);
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
