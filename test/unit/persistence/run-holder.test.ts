import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Result } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { expect } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";
import { makeRunnerRunLifecycle } from "../../../src/lib/provider/runner/runner-retirement.js";

const layer = makePersistenceEffectLayer(":memory:", "project");
const requested = (runId: string) =>
	canonicalEvent(
		"run.requested",
		"session",
		{ runId, inputId: runId },
		{
			provider: "claude",
			metadata: { runId },
		},
	);
const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const commit = yield* makeCommitAndSignal;
	yield* commit([
		canonicalEvent("session.created", "session", {
			sessionId: "session",
			title: "session",
			provider: "claude",
		}),
		requested("run"),
	]);
	const receipts = yield* makeRunnerReceiptStore(sql);
	yield* receipts.register(
		"runner",
		{ sessionId: "session", pid: 100, startTime: "start" },
		"serving",
	);
	yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
		VALUES (0, 'send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 0, 0)`;
	const lifecycle = makeRunnerRunLifecycle({
		sql,
		commit,
		eventStore: yield* EventStoreEffectTag,
	});
	return { sql, commit, lifecycle };
});

// Failure cases: Stop wins before dispatch, a failed append or projection leaves
// partial ownership, a join loses its holder, or a handoff retains the old holder.
describe("durable run holder", () => {
	for (const runId of ["run", "joined"])
		for (const covered of [false, true])
			it.effect(
				`rejects a mismatched command identity without mutation, run=${runId}, covered=${covered}`,
				() =>
					Effect.gen(function* () {
						const { sql, commit, lifecycle } = yield* setup;
						yield* commit([requested("joined")]);
						yield* sql`DELETE FROM provider_command_outbox`;
						yield* sql`UPDATE provider_runs SET joined_into = 'run', status = 'joined' WHERE id = 'joined'`;
						yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
							VALUES (1, 'owner-send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1)`;
						if (covered)
							yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
								VALUES (2, 'stop', 'project', 'session', 'claude', 'end_session', '{"stop":{"owners":[{"runId":"run"}]}}', 'completed', 2, 2)`;
						expect(
							yield* Effect.result(
								lifecycle.holdRun({
									sessionId: "session",
									runId,
									commandId: "wrong-send",
								}),
							),
						).toEqual(Result.succeed({ _tag: "Ended" }));
						expect(
							yield* sql`SELECT status, runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
						).toEqual([
							{ status: "pending", runner_id: null, held_transmission: null },
						]);
						expect(
							yield* sql`SELECT type FROM events WHERE type IN ('run.dispatched', 'turn.error', 'turn.interrupted')`,
						).toEqual([]);
					}).pipe(Effect.provide(layer)),
			);
	it.effect(
		"uses the live running command identity despite a newer historical or pending row",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				yield* sql`DELETE FROM provider_command_outbox`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
					VALUES (1, 'active-send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1),
						(2, 'historical-send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'completed', 2, 2),
						(3, 'pending-send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'pending', 3, 3)`;
				expect(
					yield* lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "active-send",
					}),
				).toEqual({ _tag: "Held", runner: "runner", transmission: 1 });
				expect(
					yield* sql`SELECT json_extract(data, '$.commandId') AS commandId FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ commandId: "active-send" }]);
			}).pipe(Effect.provide(layer)),
	);
	it.effect(
		"releaseRun appends stale evidence without releasing and rolls a failed matching release back",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				yield* lifecycle.holdRun({
					sessionId: "session",
					runId: "run",
					commandId: "send",
				});
				const release = (transmission: number) =>
					lifecycle.releaseRun({
						sessionId: "session",
						runId: "run",
						runnerId: "runner",
						commandId: "send",
						transmission,
						reason: "Refused",
					});
				expect(yield* release(0)).toEqual({ released: false });
				expect(
					yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: "runner", held_transmission: 1 }]);
				yield* sql`CREATE TRIGGER reject_release BEFORE INSERT ON events WHEN NEW.type = 'run.released' BEGIN SELECT RAISE(ABORT, 'release failed'); END`;
				expect((yield* Effect.result(release(1)))._tag).toBe("Failure");
				expect(
					yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: "runner", held_transmission: 1 }]);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.released'`,
				).toEqual([{ n: 1 }]);
				yield* sql`DROP TRIGGER reject_release`;
				expect(yield* release(1)).toEqual({ released: true });
				expect(
					yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: null, held_transmission: null }]);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.released'`,
				).toEqual([{ n: 2 }]);
			}).pipe(Effect.provide(layer)),
	);

	it.effect("releaseRun clears a matching retired hold", () =>
		Effect.gen(function* () {
			const { sql, lifecycle } = yield* setup;
			yield* lifecycle.holdRun({
				sessionId: "session",
				runId: "run",
				commandId: "send",
			});
			yield* sql`UPDATE claude_runner_cursors SET retired_at = 1 WHERE runner_id = 'runner'`;
			expect(
				yield* lifecycle.releaseRun({
					sessionId: "session",
					runId: "run",
					runnerId: "runner",
					commandId: "send",
					transmission: 1,
					reason: "JournalAbsent",
				}),
			).toEqual({ released: true });
			expect(
				yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
			).toEqual([{ runner_id: null, held_transmission: null }]);
		}).pipe(Effect.provide(layer)),
	);
	it.effect(
		"returns Unserved without appending when no serving runner exists",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				yield* sql`UPDATE claude_runner_cursors SET retired_at = 1`;
				expect(
					yield* lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
					}),
				).toEqual({
					_tag: "Unserved",
					predecessor: Option.some({ runner: "runner", until: 4001 }),
				});
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ n: 0 }]);
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"settles an unheld covered run once before looking for a serving runner",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				yield* sql`UPDATE claude_runner_cursors SET retired_at = 1`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
				VALUES (1, 'stop', 'project', 'session', 'claude', 'end_session', '{"stop":{"owners":[{"runId":"run"}]} }', 'completed', 1, 1)`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
					VALUES (2, 'send', 'project', 'session', 'claude', 'send_turn', '{"prompt":"hello"}', 'run', 'running', 1, 1)`;
				for (let n = 0; n < 2; n++)
					expect(
						yield* lifecycle.holdRun({
							sessionId: "session",
							runId: "run",
							commandId: "send",
						}),
					).toEqual({ _tag: n === 0 ? "Covered" : "Ended" });
				expect(
					yield* sql`SELECT status, runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([
					{ status: "interrupted", runner_id: null, held_transmission: null },
				]);
				expect(
					yield* sql`SELECT type, data FROM events WHERE type = 'turn.interrupted'`,
				).toEqual([
					{
						type: "turn.interrupted",
						data: JSON.stringify({
							messageId: "",
							reason: "Stopped before delivery",
						}),
					},
				]);
			}).pipe(Effect.provide(layer)),
	);

	it.effect("leaves a covered held run for its holder to settle", () =>
		Effect.gen(function* () {
			const { sql, lifecycle } = yield* setup;
			yield* lifecycle.holdRun({
				sessionId: "session",
				runId: "run",
				commandId: "send",
			});
			yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
				VALUES (1, 'stop', 'project', 'session', 'claude', 'end_session', '{"stop":{"owners":[{"runId":"run"}]} }', 'completed', 1, 1)`;
			expect(
				yield* lifecycle.holdRun({
					sessionId: "session",
					runId: "run",
					commandId: "send",
				}),
			).toEqual({ _tag: "Covered" });
			expect(
				yield* sql`SELECT status, runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
			).toEqual([
				{ status: "pending", runner_id: "runner", held_transmission: 1 },
			]);
			expect(
				yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'turn.interrupted'`,
			).toEqual([{ n: 0 }]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"guards releases by runner and transmission and rebuilds the released hold in event order",
		() =>
			Effect.gen(function* () {
				const { sql, commit, lifecycle } = yield* setup;
				const release = (runnerId: string, transmission: number) =>
					commit([
						canonicalEvent(
							"run.released",
							"session",
							{
								runId: "run",
								runnerId,
								commandId: "send",
								transmission,
								reason: "NotSent",
							},
							{ provider: "claude", metadata: { runId: "run" } },
						),
					]);
				yield* lifecycle.holdRun({
					sessionId: "session",
					runId: "run",
					commandId: "send",
				});
				yield* release("foreign", 1);
				yield* release("runner", 2);
				expect(
					yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: "runner", held_transmission: 1 }]);
				yield* release("runner", 1);
				expect(
					yield* lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
					}),
				).toEqual({ _tag: "Held", runner: "runner", transmission: 2 });
				yield* release("runner", 1);
				expect(
					yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: "runner", held_transmission: 2 }]);
				yield* release("runner", 2);
				yield* release("runner", 2);
				yield* sql`DELETE FROM provider_runs`;
				yield* sql`DELETE FROM projector_cursors WHERE projector_name = 'turn' OR projector_name LIKE '@batch:%'`;
				const projector = yield* ProjectionRunnerEffectTag;
				yield* projector.recover();
				expect(
					yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: null, held_transmission: null }]);
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"caps transmissions durably by command across runs and settles exhaustion once",
		() =>
			Effect.gen(function* () {
				const { sql, commit, lifecycle } = yield* setup;
				for (let n = 1; n <= 5; n++) {
					const runId = n === 1 ? "run" : `run-${n}`;
					if (n > 1) {
						yield* commit([requested(runId)]);
						yield* sql`UPDATE provider_command_outbox SET run_id = ${runId} WHERE command_id = 'send'`;
					}
					expect(
						yield* lifecycle.holdRun({
							sessionId: "session",
							runId,
							commandId: "send",
						}),
					).toEqual({ _tag: "Held", runner: "runner", transmission: n });
					yield* commit([
						canonicalEvent(
							"run.released",
							"session",
							{
								runId,
								runnerId: "runner",
								commandId: "send",
								transmission: n,
								reason: "Refused",
							},
							{ provider: "claude", metadata: { runId } },
						),
					]);
				}
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
					VALUES (1, 'send', 'project', 'session', 'claude', 'send_turn', '{"prompt":"hello"}', 'run-5', 'running', 1, 1)`;
				yield* sql`UPDATE claude_runner_cursors SET retired_at = 1`;
				expect(
					yield* lifecycle.holdRun({
						sessionId: "session",
						runId: "run-5",
						commandId: "send",
					}),
				).toEqual({ _tag: "Exhausted" });
				expect(
					yield* Effect.result(
						lifecycle.holdRun({
							sessionId: "session",
							runId: "run-5",
							commandId: "send",
						}),
					),
				).toEqual(Result.succeed({ _tag: "Ended" }));
				expect(
					yield* sql`SELECT status FROM provider_runs WHERE id = 'run-5'`,
				).toEqual([{ status: "error" }]);
				expect(
					yield* sql`SELECT json_extract(data, '$.code') AS code FROM events WHERE type = 'turn.error'`,
				).toEqual([{ code: "provider_send_attempts_exhausted" }]);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ n: 5 }]);
			}).pipe(Effect.provide(layer)),
	);
	it.effect(
		"serializes the retirement write with the holder check and dispatch append",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				const checked = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				let gated = false;
				let retired = false;
				const dispatch = yield* lifecycle
					.holdRun({ sessionId: "session", runId: "run", commandId: "send" })
					.pipe(
						Effect.provideService(Statement.CurrentTransformer, (statement) => {
							if (
								gated ||
								!statement.compile()[0].includes("FROM claude_runner_cursors")
							)
								return Effect.succeed(statement);
							gated = true;
							return Deferred.succeed(checked, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.as(statement),
							);
						}),
						Effect.forkChild,
					);
				yield* Deferred.await(checked);
				const stop = yield* sql
					.withTransaction(
						sql`UPDATE claude_runner_cursors SET retired_at = 1 WHERE runner_id = 'runner'`,
					)
					.pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								retired = true;
							}),
						),
						Effect.forkChild,
					);
				yield* Effect.yieldNow;
				expect(retired).toBe(false);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(dispatch);
				yield* Fiber.join(stop);
				expect(retired).toBe(true);
				expect(
					yield* sql`SELECT runner_id FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: "runner" }]);
				expect(
					yield* Effect.result(
						lifecycle.holdRun({
							sessionId: "session",
							runId: "run",
							commandId: "send",
						}),
					),
				).toEqual(Result.succeed({ _tag: "Busy" }));
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"commits the holder before dispatch and refuses an already retired runner before append",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				yield* sql`UPDATE claude_runner_cursors SET runner_id = 'first'`;
				expect(
					yield* lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
					}),
				).toEqual({ _tag: "Held", runner: "first", transmission: 1 });
				expect(
					yield* sql`SELECT runner_id, status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: "first", status: "pending" }]);
				expect(
					yield* sql`SELECT type, data FROM events WHERE type = 'run.dispatched'`,
				).toEqual([
					{
						type: "run.dispatched",
						data: JSON.stringify({
							runId: "run",
							runnerId: "first",
							commandId: "send",
							transmission: 1,
						}),
					},
				]);
				yield* sql.withTransaction(
					sql`UPDATE claude_runner_cursors SET retired_at = 1 WHERE runner_id = 'first'`,
				);
				const refused = yield* Effect.result(
					lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
					}),
				);
				expect(refused).toEqual(Result.succeed({ _tag: "Busy" }));
				expect(
					yield* sql`SELECT runner_id FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: "first" }]);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ n: 1 }]);
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"rolls back both event and holder when append or projection fails",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				for (const failAt of ["append", "projection"] as const) {
					yield* sql.unsafe(
						failAt === "append"
							? `CREATE TRIGGER reject_holder BEFORE INSERT ON events WHEN NEW.type = 'run.dispatched' BEGIN SELECT RAISE(ABORT, 'append failed'); END`
							: `CREATE TRIGGER reject_holder BEFORE UPDATE OF runner_id ON provider_runs BEGIN SELECT RAISE(ABORT, 'projection failed'); END`,
					);
					const failed = yield* Effect.exit(
						lifecycle.holdRun({
							sessionId: "session",
							runId: "run",
							commandId: "send",
						}),
					);
					expect(failed._tag).toBe("Failure");
					expect(
						yield* sql`SELECT runner_id FROM provider_runs WHERE id = 'run'`,
					).toEqual([{ runner_id: null }]);
					expect(
						yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.dispatched'`,
					).toEqual([{ n: 0 }]);
					yield* sql`DROP TRIGGER reject_holder`;
				}
				yield* lifecycle.holdRun({
					sessionId: "session",
					runId: "run",
					commandId: "send",
				});
				expect(
					yield* sql`SELECT runner_id FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: "runner" }]);
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"keeps the owner's hold on join and resolves the joined run through the owner for its next transmission",
		() =>
			Effect.gen(function* () {
				const { sql, commit, lifecycle } = yield* setup;
				yield* sql`UPDATE claude_runner_cursors SET runner_id = 'old'`;
				yield* sql`DELETE FROM provider_command_outbox`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at, run_id)
					VALUES (1, 'owner-send', 'project', 'session', 'claude', 'send_turn', '{}', 'running', 1, 1, 'run')`;
				yield* lifecycle.holdRun({
					sessionId: "session",
					runId: "run",
					commandId: "owner-send",
				});
				yield* commit([requested("joined")]);
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at) VALUES (2, 'steer', 'project', 'session', 'claude', 'send_turn', '{}', 'joined', 'running', 2, 2)`;
				yield* sql`UPDATE claude_runner_cursors SET runner_id = 'new'`;
				yield* lifecycle.holdRun({
					sessionId: "session",
					runId: "joined",
					commandId: "steer",
				});
				yield* commit([
					canonicalEvent(
						"run.started",
						"session",
						{
							inputId: "joined",
							requestedRunId: "joined",
						},
						{ provider: "claude", metadata: { runId: "run" } },
					),
				]);
				expect(
					yield* sql`SELECT id, runner_id, status, joined_into FROM provider_runs ORDER BY id`,
				).toEqual([
					{
						id: "joined",
						runner_id: "new",
						status: "joined",
						joined_into: "run",
					},
					{ id: "run", runner_id: "old", status: "running", joined_into: null },
				]);
				yield* sql`UPDATE claude_runner_cursors SET runner_id = 'handoff'`;
				yield* commit([
					canonicalEvent(
						"run.released",
						"session",
						{
							runId: "run",
							runnerId: "old",
							commandId: "owner-send",
							transmission: 1,
							reason: "NotSent",
						},
						{ provider: "claude", metadata: { runId: "run" } },
					),
				]);
				expect(
					yield* lifecycle.holdRun({
						sessionId: "session",
						runId: "joined",
						commandId: "owner-send",
					}),
				).toEqual({ _tag: "Held", runner: "handoff", transmission: 2 });
				expect(
					yield* sql`SELECT id, runner_id FROM provider_runs ORDER BY id`,
				).toEqual([
					{ id: "joined", runner_id: "new" },
					{ id: "run", runner_id: "handoff" },
				]);
			}).pipe(Effect.provide(layer)),
	);

	// 4.3, 4.8 (CONTRACT 1535-1537, 1868-1869): from 32.5 a joined steer is bound
	// under its own commandId, its count and hold its own, while its owner's start
	// stays held on the same runner.
	it.effect(
		"binds a joined steer under its own commandId with its own count and hold",
		() =>
			Effect.gen(function* () {
				const { sql, commit, lifecycle } = yield* setup;
				yield* lifecycle.holdRun({
					sessionId: "session",
					runId: "run",
					commandId: "send",
				});
				yield* commit([requested("joined")]);
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
					VALUES (1, 'steer', 'project', 'session', 'claude', 'send_turn', '{}', 'joined', 'running', 1, 1)`;
				yield* sql`UPDATE provider_runs SET joined_into = 'run', status = 'joined' WHERE id = 'joined'`;
				const hold = lifecycle.holdRun({
					sessionId: "session",
					runId: "joined",
					commandId: "steer",
				});
				expect(yield* hold).toEqual({
					_tag: "Held",
					runner: "runner",
					transmission: 1,
				});
				expect(yield* hold).toEqual({ _tag: "Busy" });
				yield* commit([
					canonicalEvent(
						"run.released",
						"session",
						{
							runId: "joined",
							runnerId: "runner",
							commandId: "steer",
							transmission: 1,
							reason: "NotSent",
						},
						{ provider: "claude", metadata: { runId: "joined" } },
					),
				]);
				expect(yield* hold).toEqual({
					_tag: "Held",
					runner: "runner",
					transmission: 2,
				});
				expect(
					yield* sql`SELECT json_extract(data, '$.runId') AS runId, json_extract(data, '$.commandId') AS commandId,
						json_extract(data, '$.transmission') AS transmission FROM events WHERE type = 'run.dispatched' ORDER BY sequence`,
				).toEqual([
					{ runId: "run", commandId: "send", transmission: 1 },
					{ runId: "joined", commandId: "steer", transmission: 1 },
					{ runId: "joined", commandId: "steer", transmission: 2 },
				]);
				expect(
					yield* sql`SELECT id, runner_id, held_transmission FROM provider_runs ORDER BY id`,
				).toEqual([
					{ id: "joined", runner_id: "runner", held_transmission: 2 },
					{ id: "run", runner_id: "runner", held_transmission: 1 },
				]);
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"refuses missing, foreign, or terminal runs without appending a dispatch",
		() =>
			Effect.gen(function* () {
				const { sql, commit, lifecycle } = yield* setup;
				for (const input of [
					{ sessionId: "session", runId: "absent", commandId: "send" },
					{ sessionId: "foreign", runId: "run", commandId: "send" },
				])
					expect(yield* Effect.result(lifecycle.holdRun(input))).toEqual(
						Result.succeed({ _tag: "Ended" }),
					);
				yield* commit([
					canonicalEvent(
						"turn.interrupted",
						"session",
						{ messageId: "" },
						{
							provider: "claude",
							metadata: { runId: "run" },
						},
					),
				]);
				expect(
					yield* Effect.result(
						lifecycle.holdRun({
							sessionId: "session",
							runId: "run",
							commandId: "send",
						}),
					),
				).toEqual(Result.succeed({ _tag: "Ended" }));
				expect(
					yield* sql`SELECT runner_id, status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: null, status: "interrupted" }]);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ n: 0 }]);
			}).pipe(Effect.provide(layer)),
	);

	// CONTRACT 218, 973-977, 1521-1524 (2.1 row 207): a held steer past the cap is failed and
	// final. How it could fail: the cap reports nothing to the ledger, so the commit's sweep
	// requeues the steer and never cancels it; it reports an effect_outcome, which a held send
	// cannot produce; it lands in a later write than the failure, whose sweep requeues first; or
	// the cap's error under the steer's own run ends its owner's Run.
	it.effect(
		"fails a held steer past the cap final in the exhausting write",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				const at = (runId: string) => ({
					provider: "cursor",
					metadata: { runId },
				});
				const hold = (runId: string, commandId: string, transmission: number) =>
					canonicalEvent(
						"run.dispatched",
						"s",
						{ runId, runnerId: "runner", commandId, transmission },
						at(runId),
					);
				yield* commit([
					canonicalEvent("session.created", "s", {
						sessionId: "s",
						title: "s",
						provider: "cursor",
					}),
					canonicalEvent("input.admitted", "s", {
						sessionId: "s",
						inputId: "owner",
						delivery: "queue",
						request: { text: "owner" },
					}),
					canonicalEvent("input.sent", "s", {
						sessionId: "s",
						inputId: "owner",
					}),
					canonicalEvent(
						"run.requested",
						"s",
						{ runId: "run:owner", inputId: "owner" },
						at("run:owner"),
					),
					hold("run:owner", "owner", 1),
					canonicalEvent(
						"run.started",
						"s",
						{ inputId: "owner", requestedRunId: "run:owner" },
						at("run:owner"),
					),
					canonicalEvent("input.admitted", "s", {
						sessionId: "s",
						inputId: "steer",
						delivery: "steer",
						request: { text: "steer" },
					}),
					canonicalEvent("input.sent", "s", {
						sessionId: "s",
						inputId: "steer",
						steer: true,
					}),
					canonicalEvent(
						"run.requested",
						"s",
						{ runId: "run:steer", inputId: "steer" },
						at("run:steer"),
					),
				]);
				yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type, project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at)
				VALUES ('steer', 's', 'side_effect_requested', 1, 'send_turn', 'project', 'sha256:steer', 1, 1, 1)`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
				VALUES (1, 'steer', 'project', 's', 'cursor', 'send_turn', '{}', 'run:steer', 'running', 1, 1, 1)`;
				// Five holds the runner returned unsent: the cap counts each.
				for (let transmission = 1; transmission <= 5; transmission++)
					yield* commit([
						hold("run:steer", "steer", transmission),
						canonicalEvent(
							"run.released",
							"s",
							{
								runId: "run:steer",
								runnerId: "runner",
								commandId: "steer",
								transmission,
								reason: "NotSent",
							},
							at("run:steer"),
						),
					]);
				const lifecycle = makeRunnerRunLifecycle({
					sql,
					commit,
					eventStore: yield* EventStoreEffectTag,
				});
				expect(
					yield* lifecycle.holdRun({
						sessionId: "s",
						runId: "run:steer",
						commandId: "steer",
					}),
				).toEqual({ _tag: "Exhausted" });
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([
					{ status: "failed", error_code: "provider_send_attempts_exhausted" },
				]);
				expect(
					yield* sql`SELECT type FROM events WHERE type IN ('input.requeued', 'input.cancelled')
					AND json_extract(data, '$.inputId') = 'steer' ORDER BY sequence`,
				).toEqual([{ type: "input.requeued" }, { type: "input.cancelled" }]);
				expect(
					yield* sql`SELECT state FROM pending_inputs WHERE input_id = 'steer'`,
				).toEqual([{ state: "removed" }]);
				// 4.8 (CONTRACT 1864-1869): the cap's error is the steer's; its owner's Run runs on.
				expect(
					yield* sql`SELECT state FROM run_ledger_sessions WHERE session_id = 's'`,
				).toEqual([{ state: "Open" }]);
			}).pipe(Effect.provide(layer)),
	);
});
