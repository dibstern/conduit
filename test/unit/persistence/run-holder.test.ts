import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { expect } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";

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
	return { sql, commit };
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
						const { sql, commit } = yield* setup;
						yield* commit([requested("joined")]);
						yield* sql`UPDATE provider_runs SET joined_into = 'run', status = 'joined' WHERE id = 'joined'`;
						yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
							VALUES (1, 'owner-send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1)`;
						if (covered)
							yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
								VALUES (2, 'stop', 'project', 'session', 'claude', 'end_session', '{"stop":{"owners":[{"runId":"run"}]}}', 'completed', 2, 2)`;
						expect(
							yield* Effect.result(
								commit.holdRun({
									sessionId: "session",
									runId,
									commandId: "wrong-send",
								}),
							),
						).toMatchObject({
							_tag: "Failure",
							failure: {
								_tag: "HoldCommandIdMismatch",
								sessionId: "session",
								runId,
								ownerRunId: "run",
								commandId: "wrong-send",
								expectedCommandId: "owner-send",
							},
						});
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
				const { sql, commit } = yield* setup;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
					VALUES (1, 'active-send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1),
						(2, 'historical-send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'completed', 2, 2),
						(3, 'pending-send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'pending', 3, 3)`;
				expect(
					yield* commit.holdRun({
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
		"releaseRun appends stale evidence without Stop side effects and rolls matching release back with its Stop",
		() =>
			Effect.gen(function* () {
				const { sql, commit } = yield* setup;
				yield* commit.holdRun({
					sessionId: "session",
					runId: "run",
					commandId: "send",
				});
				let stops = 0;
				const stop =
					sql`UPDATE claude_runner_cursors SET retired_at = 1 WHERE runner_id = 'runner'`.pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								stops++;
							}),
						),
						Effect.as("stopped"),
					);
				const release = (transmission: number) =>
					commit.releaseRun(
						{
							sessionId: "session",
							runId: "run",
							runnerId: "runner",
							commandId: "send",
							transmission,
							reason: "Refused",
						},
						stop,
					);
				expect(yield* release(0)).toEqual({ released: false, stop: undefined });
				expect(stops).toBe(0);
				expect(
					yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: "runner", held_transmission: 1 }]);
				yield* sql`CREATE TRIGGER reject_release_stop BEFORE UPDATE OF retired_at ON claude_runner_cursors BEGIN SELECT RAISE(ABORT, 'stop failed'); END`;
				expect((yield* Effect.result(release(1)))._tag).toBe("Failure");
				expect(stops).toBe(0);
				expect(
					yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: "runner", held_transmission: 1 }]);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.released'`,
				).toEqual([{ n: 1 }]);
				yield* sql`DROP TRIGGER reject_release_stop`;
				expect(yield* release(1)).toEqual({ released: true, stop: "stopped" });
				expect(stops).toBe(1);
				expect(
					yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: null, held_transmission: null }]);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.released'`,
				).toEqual([{ n: 2 }]);
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"releaseRun clears a matching retired hold without running another Stop mutation",
		() =>
			Effect.gen(function* () {
				const { sql, commit } = yield* setup;
				yield* commit.holdRun({
					sessionId: "session",
					runId: "run",
					commandId: "send",
				});
				yield* sql`UPDATE claude_runner_cursors SET retired_at = 1 WHERE runner_id = 'runner'`;
				let stopped = false;
				expect(
					yield* commit.releaseRun(
						{
							sessionId: "session",
							runId: "run",
							runnerId: "runner",
							commandId: "send",
							transmission: 1,
							reason: "JournalAbsent",
						},
						Effect.sync(() => {
							stopped = true;
						}),
					),
				).toEqual({ released: true, stop: undefined });
				expect(stopped).toBe(false);
				expect(
					yield* sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: null, held_transmission: null }]);
			}).pipe(Effect.provide(layer)),
	);
	it.effect(
		"returns Unserved without appending when no serving runner exists",
		() =>
			Effect.gen(function* () {
				const { sql, commit } = yield* setup;
				yield* sql`UPDATE claude_runner_cursors SET retired_at = 1`;
				expect(
					yield* commit.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
					}),
				).toEqual({ _tag: "Unserved" });
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ n: 0 }]);
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"settles an unheld covered run once before looking for a serving runner",
		() =>
			Effect.gen(function* () {
				const { sql, commit } = yield* setup;
				yield* sql`UPDATE claude_runner_cursors SET retired_at = 1`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
				VALUES (1, 'stop', 'project', 'session', 'claude', 'end_session', '{"stop":{"owners":[{"runId":"run"}]} }', 'completed', 1, 1)`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
					VALUES (2, 'send', 'project', 'session', 'claude', 'send_turn', '{"prompt":"hello"}', 'run', 'running', 1, 1)`;
				for (let n = 0; n < 2; n++)
					expect(
						yield* commit.holdRun({
							sessionId: "session",
							runId: "run",
							commandId: "send",
						}),
					).toEqual({ _tag: "Covered" });
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
			const { sql, commit } = yield* setup;
			yield* commit.holdRun({
				sessionId: "session",
				runId: "run",
				commandId: "send",
			});
			yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
				VALUES (1, 'stop', 'project', 'session', 'claude', 'end_session', '{"stop":{"owners":[{"runId":"run"}]} }', 'completed', 1, 1)`;
			expect(
				yield* commit.holdRun({
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
				const { sql, commit } = yield* setup;
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
				yield* commit.holdRun({
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
					yield* commit.holdRun({
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
				const { sql, commit } = yield* setup;
				for (let n = 1; n <= 5; n++) {
					const runId = n === 1 ? "run" : `run-${n}`;
					if (n > 1) yield* commit([requested(runId)]);
					expect(
						yield* commit.holdRun({
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
					yield* commit.holdRun({
						sessionId: "session",
						runId: "run-5",
						commandId: "send",
					}),
				).toEqual({ _tag: "Exhausted" });
				expect(
					(yield* Effect.result(
						commit.holdRun({
							sessionId: "session",
							runId: "run-5",
							commandId: "send",
						}),
					))._tag,
				).toBe("Failure");
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
				const { sql, commit } = yield* setup;
				const checked = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				let gated = false;
				let retired = false;
				const dispatch = yield* commit
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
					(yield* Effect.result(
						commit.holdRun({
							sessionId: "session",
							runId: "run",
							commandId: "send",
						}),
					))._tag,
				).toBe("Failure");
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"commits the holder before dispatch and refuses an already retired runner before append",
		() =>
			Effect.gen(function* () {
				const { sql, commit } = yield* setup;
				yield* sql`UPDATE claude_runner_cursors SET runner_id = 'first'`;
				expect(
					yield* commit.holdRun({
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
					commit.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
					}),
				);
				expect(refused).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "EventStoreError", operation: "holdRun" },
				});
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
				const { sql, commit } = yield* setup;
				for (const failAt of ["append", "projection"] as const) {
					yield* sql.unsafe(
						failAt === "append"
							? `CREATE TRIGGER reject_holder BEFORE INSERT ON events WHEN NEW.type = 'run.dispatched' BEGIN SELECT RAISE(ABORT, 'append failed'); END`
							: `CREATE TRIGGER reject_holder BEFORE UPDATE OF runner_id ON provider_runs BEGIN SELECT RAISE(ABORT, 'projection failed'); END`,
					);
					const failed = yield* Effect.exit(
						commit.holdRun({
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
				yield* commit.holdRun({
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
				const { sql, commit } = yield* setup;
				yield* sql`UPDATE claude_runner_cursors SET runner_id = 'old'`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at, run_id)
					VALUES (1, 'owner-send', 'project', 'session', 'claude', 'send_turn', '{}', 'running', 1, 1, 'run')`;
				yield* commit.holdRun({
					sessionId: "session",
					runId: "run",
					commandId: "owner-send",
				});
				yield* commit([requested("joined")]);
				yield* sql`UPDATE claude_runner_cursors SET runner_id = 'new'`;
				yield* commit.holdRun({
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
					yield* commit.holdRun({
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

	it.effect(
		"refuses missing, foreign, or terminal runs without appending a dispatch",
		() =>
			Effect.gen(function* () {
				const { sql, commit } = yield* setup;
				for (const input of [
					{ sessionId: "session", runId: "absent", commandId: "send" },
					{ sessionId: "foreign", runId: "run", commandId: "send" },
				])
					expect((yield* Effect.result(commit.holdRun(input)))._tag).toBe(
						"Failure",
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
					(yield* Effect.result(
						commit.holdRun({
							sessionId: "session",
							runId: "run",
							commandId: "send",
						}),
					))._tag,
				).toBe("Failure");
				expect(
					yield* sql`SELECT runner_id, status FROM provider_runs WHERE id = 'run'`,
				).toEqual([{ runner_id: null, status: "interrupted" }]);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ n: 0 }]);
			}).pipe(Effect.provide(layer)),
	);
});
