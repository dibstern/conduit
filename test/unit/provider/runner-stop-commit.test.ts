import { it } from "@effect/vitest";
import { Effect, Fiber, type Scope } from "effect";
import { SqlClient } from "effect/sql";
import { ConnectionError, SqlError, UnknownError } from "effect/sql/SqlError";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import type { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { runnerFailure } from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	makeRunnerReceiptStore,
	type RunnerRetirement,
} from "../../../src/lib/provider/runner/runner-receipts.js";
import {
	makeRunnerRunLifecycle,
	makeRunnerStopReconciler,
	type RunRelease,
} from "../../../src/lib/provider/runner/runner-retirement.js";

// Failure modes 55-59, 70, 76, 81 and 82 at the Stop and release interfaces:
// a real SQLite store whose Stop fence read fails while `fault.down` is set.
const layer = makePersistenceEffectLayer(":memory:", "project");
const target = (runnerId: string, pid: number): RunnerRetirement => ({
	runnerId,
	sessionId: "session",
	driverKind: "claude",
	identity: { tag: "Verified", pid, startTime: "started" },
	reaper: undefined,
	members: [],
	signalLog: [],
	signal: { tag: "None" },
	retirement: { tag: "Watching" },
	ownedRunIds: [],
	retiredAt: 0,
});
const refusal: RunRelease = {
	sessionId: "session",
	runId: "run",
	runnerId: "runner",
	commandId: "send",
	transmission: 1,
	reason: "Refused",
	refusalReason: "exiting",
};

const harness = Effect.gen(function* () {
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
	yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at) VALUES (1, 'send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1)`;
	const lifecycle = makeRunnerRunLifecycle({
		sql,
		commit,
		eventStore: yield* EventStoreEffectTag,
	});
	const actions: string[] = [];
	const live = new Set([123, 124]);
	const fault = {
		down: false,
		fences: 0,
		error: new SqlError({
			reason: new ConnectionError({ cause: "Stop commit unavailable" }),
		}),
	};
	const connection = yield* Effect.scoped(sql.reserve);
	const execute = connection.execute;
	const injected = vi
		.spyOn(connection, "execute")
		.mockImplementation((query, params, transform) => {
			if (
				query.includes(
					"SELECT retired_at, role, session_id FROM claude_runner_cursors",
				)
			) {
				fault.fences++;
				if (fault.down) return Effect.fail(fault.error);
			}
			return execute(query, params, transform);
		});
	yield* Effect.addFinalizer(() => Effect.sync(() => injected.mockRestore()));
	const record =
		(action: string) =>
		(retired: { readonly runnerId: string }): Effect.Effect<void> =>
			Effect.sync(() => {
				actions.push(`${action} ${retired.runnerId}`);
			});
	const options: Parameters<typeof makeRunnerStopReconciler>[0] = {
		receipts,
		processTable: {
			inspect: (pid) =>
				live.has(pid)
					? { state: "running", startTime: "started", pgid: pid }
					: { state: "gone" },
			signal: (pid, signal) => {
				actions.push(`signal ${pid} ${signal}`);
			},
		},
		holdRun: (sessionId, runId, commandId) =>
			lifecycle.holdRun({ sessionId, runId, commandId }),
		release: (input, stop) =>
			lifecycle
				.releaseRun(input, stop ?? (() => Effect.succeed(undefined)))
				.pipe(Effect.mapError((cause) => runnerFailure("release run", cause))),
		released: record("released"),
		committed: record("committed"),
		shutdown: record("shutdown"),
		evict: record("evict"),
		prune: record("prune"),
		notice: () => Effect.succeed(true),
	};
	const reconciler = yield* makeRunnerStopReconciler(options);
	const retired = (runnerId: string) =>
		sql<{
			retired_at: number | null;
			stop_reason: string | null;
			role: string;
		}>`SELECT retired_at, stop_reason, role FROM claude_runner_cursors WHERE runner_id = ${runnerId}`;
	return {
		sql,
		receipts,
		lifecycle,
		reconciler,
		options,
		actions,
		live,
		fault,
		retired,
	};
});
const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		| SqlClient.SqlClient
		| EventStoreEffectTag
		| ProjectionRunnerEffectTag
		| Scope.Scope
	>,
) => Effect.scoped(effect).pipe(Effect.provide(layer));

it.effect(
	"F58 a user Stop whose commit is unavailable keeps serving, waits, and lands once through the reconciler",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* harness;
				yield* f.reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"serving",
				);
				// The user Stop's durable interrupt control is committed before its Stop.
				yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at) VALUES (2, 'stop', 'project', 'session', 'claude', 'interrupt_turn', '{"stop":{"owners":[{"runId":"run"}]}}', 'running', 1, 1)`;
				f.fault.down = true;
				const stopping = yield* f.reconciler
					.requestStop(target("runner", 123), { _tag: "Explicit" })
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				expect(f.fault.fences).toBe(1);
				expect(stopping.pollUnsafe()).toBeUndefined();
				expect(f.reconciler.state("runner")._tag).toBe("Committing");
				expect(f.reconciler.serving("session")).toBe("runner");
				expect(yield* f.retired("runner")).toEqual([
					{
						retired_at: null,
						stop_reason: "Provider process stopped",
						role: "serving",
					},
				]);
				// Coverage holds through holdRun step 1 while the Stop is uncommitted.
				expect(
					yield* f.lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
					}),
				).toEqual({ _tag: "Covered" });
				f.fault.down = false;
				yield* TestClock.adjust("999 millis");
				expect(f.fault.fences).toBe(1);
				yield* TestClock.adjust("1 millis");
				expect(yield* Fiber.join(stopping)).toBe("Requested");
				expect(f.fault.fences).toBe(2);
				// retired_at is the successful commit's time, not the first attempt's.
				expect(yield* f.retired("runner")).toEqual([
					{
						retired_at: 1000,
						stop_reason: '{"_tag":"Explicit"}',
						role: "serving",
					},
				]);
				expect(f.actions.filter((a) => a.startsWith("shutdown"))).toEqual([
					"shutdown runner",
				]);
				expect(f.reconciler.serving("session")).toBeUndefined();
			}),
		),
);

it.effect(
	"F82 an unavailable Stop commit sends no shutdown or signal and performs no settlement or prune",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* harness;
				yield* f.reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"serving",
				);
				f.fault.down = true;
				const stopping = yield* f.reconciler
					.requestStop(target("runner", 123), { _tag: "Idle" })
					.pipe(Effect.forkChild);
				// Backoff 1 s, 2 s, 4 s (4.8): four attempts by 7 s.
				yield* TestClock.adjust("7 seconds");
				expect(f.fault.fences).toBe(4);
				expect(stopping.pollUnsafe()).toBeUndefined();
				expect(f.reconciler.state("runner")._tag).toBe("Committing");
				expect(f.actions).toEqual([]);
				f.fault.down = false;
				yield* TestClock.adjust("8 seconds");
				expect(f.fault.fences).toBe(5);
				expect(yield* Fiber.join(stopping)).toBe("Requested");
				expect(f.actions.filter((a) => a.startsWith("shutdown"))).toEqual([
					"shutdown runner",
				]);
			}),
		),
);

it.effect(
	"F76 a cancelled Stop caller still commits, a joiner joins, and a decode rejection fails its waiters unsignalled",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* harness;
				yield* f.reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"serving",
				);
				f.fault.down = true;
				const cancelled = yield* f.reconciler
					.requestStop(target("runner", 123), { _tag: "EndSession" })
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				yield* Fiber.interrupt(cancelled);
				expect(f.reconciler.state("runner")._tag).toBe("Committing");
				const joiner = yield* f.reconciler
					.requestStop(target("runner", 123), { _tag: "EndSession" })
					.pipe(Effect.forkChild);
				f.fault.down = false;
				yield* TestClock.adjust("1 second");
				expect(yield* Fiber.join(joiner)).toBe("Requested");
				expect(f.fault.fences).toBe(2);
				expect(yield* f.retired("runner")).toEqual([
					{
						retired_at: 1000,
						stop_reason: '{"_tag":"EndSession"}',
						role: "serving",
					},
				]);

				// A row that cannot be decoded is a rejection: no retry, no signal.
				yield* f.reconciler.register(
					"other",
					{ sessionId: "other-session", pid: 124, startTime: "started" },
					"serving",
				);
				yield* f.sql`UPDATE claude_runner_cursors SET member_snapshot = 'not json' WHERE runner_id = 'other'`;
				const fences = f.fault.fences;
				const rejected = yield* Effect.result(
					f.reconciler.requestStop(
						{ ...target("other", 124), sessionId: "other-session" },
						{ _tag: "Explicit" },
					),
				);
				expect(rejected._tag).toBe("Failure");
				expect(f.reconciler.state("other")).toEqual({ _tag: "Running" });
				yield* TestClock.adjust("30 seconds");
				expect(f.fault.fences).toBe(fences + 1);
				expect(
					f.actions.filter((a) => a.includes("other") || a.includes("124")),
				).toEqual([]);
			}),
		),
);

it.effect(
	"F81 a promoted candidate's CandidateAbandoned is Ignored, and a joined different Stop rechecks its reason",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* harness;
				yield* f.reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"serving",
				);
				yield* f.reconciler.register(
					"successor",
					{ sessionId: "session", pid: 124, startTime: "started" },
					"candidate",
				);
				expect(
					yield* f.reconciler.requestStop(target("runner", 123), {
						_tag: "Superseded",
						successor: "successor",
					}),
				).toBe("Requested");
				const actions = f.actions.length;
				expect(
					yield* f.reconciler.requestStop(target("successor", 124), {
						_tag: "CandidateAbandoned",
					}),
				).toBe("Ignored");
				expect(f.reconciler.state("successor")).toEqual({ _tag: "Running" });
				expect(f.reconciler.serving("session")).toBe("successor");
				expect(yield* f.retired("successor")).toEqual([
					{
						retired_at: null,
						stop_reason: "Provider process stopped",
						role: "serving",
					},
				]);
				yield* TestClock.adjust("10 seconds");
				expect(
					f.actions.slice(actions).filter((a) => a.includes("successor")),
				).toEqual([]);

				// An Explicit Stop joining an Ignored commit runs its own reason.
				f.fault.down = true;
				const abandoned = yield* f.reconciler
					.requestStop(target("successor", 124), {
						_tag: "CandidateAbandoned",
					})
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				const explicit = yield* f.reconciler
					.requestStop(target("successor", 124), { _tag: "Explicit" })
					.pipe(Effect.forkChild);
				f.fault.down = false;
				yield* TestClock.adjust("1 second");
				expect(yield* Fiber.join(abandoned)).toBe("Ignored");
				expect(yield* Fiber.join(explicit)).toBe("Requested");
				expect(yield* f.retired("successor")).toMatchObject([
					{ stop_reason: '{"_tag":"Explicit"}', role: "serving" },
				]);
			}),
		),
);

it.effect(
	"F70 an upgrade candidate stop whose row is already serving writes nothing and keeps serving",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* harness;
				yield* f.reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"serving",
				);
				yield* f.reconciler.register(
					"candidate",
					{ sessionId: "session", pid: 124, startTime: "started" },
					"candidate",
				);
				// Another writer promoted the candidate; memory still shows a candidate.
				yield* f.sql`UPDATE claude_runner_cursors SET retired_at = 5 WHERE runner_id = 'runner'`;
				yield* f.sql`UPDATE claude_runner_cursors SET role = 'serving' WHERE runner_id = 'candidate'`;
				const before =
					yield* f.sql`SELECT * FROM claude_runner_cursors ORDER BY rowid`;
				expect(
					yield* f.reconciler.requestStop(target("candidate", 124), {
						_tag: "CandidateAbandoned",
					}),
				).toBe("Ignored");
				expect(
					yield* f.sql`SELECT * FROM claude_runner_cursors ORDER BY rowid`,
				).toEqual(before);
				expect(f.reconciler.state("candidate")).toEqual({ _tag: "Running" });
				yield* TestClock.adjust("10 seconds");
				expect(f.actions).toEqual([]);
			}),
		),
);

it.effect(
	"F59 a release stops the serving row its transaction read, not the stale registry's",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* harness;
				yield* f.reconciler.register(
					"predecessor",
					{ sessionId: "session", pid: 124, startTime: "started" },
					"serving",
				);
				yield* f.reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"candidate",
				);
				yield* f.sql`UPDATE claude_runner_cursors SET retired_at = 1 WHERE runner_id = 'predecessor'`;
				yield* f.sql`UPDATE claude_runner_cursors SET role = 'serving' WHERE runner_id = 'runner'`;
				expect(f.reconciler.serving("session")).toBe("predecessor");
				expect(
					yield* f.lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
					}),
				).toMatchObject({ _tag: "Held", runner: "runner" });
				yield* f.reconciler.release(refusal);
				expect(f.actions.slice(0, 2)).toEqual([
					"released runner",
					"committed runner",
				]);
				expect(yield* f.retired("runner")).toEqual([
					{ retired_at: 0, stop_reason: '{"_tag":"Idle"}', role: "serving" },
				]);
				expect(f.reconciler.serving("session")).toBeUndefined();
			}),
		),
);

it.effect(
	"F56 a daemon that dies before the candidate Stop commits stops the candidate row at restart",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* harness;
				yield* f.reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"serving",
				);
				yield* f.reconciler.register(
					"candidate",
					{ sessionId: "session", pid: 124, startTime: "started" },
					"candidate",
				);
				f.fault.down = true;
				yield* f.reconciler
					.requestStop(target("candidate", 124), {
						_tag: "CandidateAbandoned",
					})
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				expect(f.reconciler.state("candidate")._tag).toBe("Committing");
				f.fault.down = false;
				// Committing is not durable; the restarted reconciler re-derives it.
				const restarted = yield* makeRunnerStopReconciler(f.options);
				yield* restarted.recover();
				expect(restarted.state("candidate")._tag).not.toBe("Running");
				expect(yield* f.retired("candidate")).toEqual([
					{
						retired_at: 0,
						stop_reason: '{"_tag":"CandidateAbandoned"}',
						role: "candidate",
					},
				]);
				expect(yield* f.retired("runner")).toMatchObject([
					{ retired_at: null, role: "serving" },
				]);
			}),
		),
);

it.effect(
	"F12 a non-retryable store error on a Stop commit keeps it Committing and the reconciler retries it",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* harness;
				yield* f.reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"serving",
				);
				// SQLITE_FULL is not retryable in effect's classification.
				f.fault.error = new SqlError({
					reason: new UnknownError({ cause: "database or disk is full" }),
				});
				f.fault.down = true;
				const stopping = yield* f.reconciler
					.requestStop(target("runner", 123), { _tag: "Idle" })
					.pipe(Effect.forkChild);
				yield* TestClock.adjust("1 second");
				expect(f.fault.fences).toBe(2);
				expect(stopping.pollUnsafe()).toBeUndefined();
				expect(f.reconciler.state("runner")._tag).toBe("Committing");
				expect(f.actions).toEqual([]);
				f.fault.down = false;
				yield* TestClock.adjust("2 seconds");
				expect(yield* Fiber.join(stopping)).toBe("Requested");
				expect(f.fault.fences).toBe(3);
				expect(yield* f.retired("runner")).toEqual([
					{ retired_at: 3000, stop_reason: '{"_tag":"Idle"}', role: "serving" },
				]);
			}),
		),
);

it.effect(
	"Q7 a Stop records the identity its row holds, and the caller fills only the reaper the row lacks",
	() =>
		run(
			Effect.gen(function* () {
				const f = yield* harness;
				yield* f.reconciler.register(
					"runner",
					{ sessionId: "session", pid: 123, startTime: "started" },
					"serving",
				);
				expect(
					yield* f.reconciler.requestStop(
						// The hello reports the reaper after register wrote the row.
						{
							...target("runner", 124),
							reaper: { pid: 200, startTime: "reaper" },
						},
						{ _tag: "Idle" },
					),
				).toBe("Requested");
				expect(
					yield* f.sql`SELECT pid, start_time, reaper_pid, reaper_start_time, retired_at FROM claude_runner_cursors WHERE runner_id = 'runner'`,
				).toEqual([
					{
						pid: 123,
						start_time: "started",
						reaper_pid: 200,
						reaper_start_time: "reaper",
						retired_at: 0,
					},
				]);
			}),
		),
);
