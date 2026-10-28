import { describe, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { makeInputDrafts } from "../../../src/lib/domain/relay/Services/input-drafts.js";
import { makeClaudeEventPersistEffect } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";
import { makeRunnerRunLifecycle } from "../../../src/lib/provider/runner/runner-retirement.js";

const layer = makePersistenceEffectLayer(":memory:", "project");
const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
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
			{ runId: "run", inputId: "send" },
			{
				provider: "claude",
				metadata: { runId: "run" },
			},
		),
	]);
	const receipts = yield* makeRunnerReceiptStore(sql);
	yield* receipts.register("runner", { sessionId: "session" }, "serving");
	yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
		VALUES (1, 'send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1)`;
	const persist = yield* makeClaudeEventPersistEffect;
	const drafts = yield* makeInputDrafts;
	const lifecycle = makeRunnerRunLifecycle({
		sql,
		commit,
		eventStore: yield* EventStoreEffectTag,
		persistUserMessage: persist.persistUserMessage,
		inputDrafts: drafts,
	});
	return { sql, lifecycle, receipts, persist };
});

describe("total run gate", () => {
	it.effect(
		"a proven preparation refusal releases and settles in one transaction",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				const input = { sessionId: "session", runId: "run", commandId: "send" };
				yield* lifecycle.holdRun(input);
				const release = {
					...input,
					runnerId: "runner",
					transmission: 1,
					reason: "NotSent" as const,
				};
				const evidence = {
					_tag: "failed" as const,
					send: { ...input, requestSequence: 1, attempt: 0 },
					failure: {
						operation: "prepare adopted send",
						code: "attachment_missing",
						message: "Missing attachment",
					},
					observedAt: 1730,
				};
				yield* sql`CREATE TRIGGER reject_preparation_terminal BEFORE INSERT ON events WHEN NEW.type = 'turn.error' BEGIN SELECT RAISE(ABORT, 'terminal write rejected'); END`;
				expect(
					(yield* Effect.result(
						lifecycle.releaseRun(release, () => Effect.void, evidence),
					))._tag,
				).toBe("Failure");
				expect(
					yield* sql`SELECT runner_id, held_transmission, status FROM provider_runs WHERE id = 'run'`,
				).toEqual([
					{ runner_id: "runner", held_transmission: 1, status: "pending" },
				]);
				expect(
					yield* sql`SELECT type FROM events WHERE type IN ('run.released', 'turn.error')`,
				).toEqual([]);
				yield* sql`DROP TRIGGER reject_preparation_terminal`;
				expect(
					yield* lifecycle.releaseRun(release, () => Effect.void, evidence),
				).toEqual({ released: true, stop: undefined });
				expect(
					yield* sql`SELECT runner_id, held_transmission, status FROM provider_runs WHERE id = 'run'`,
				).toEqual([
					{ runner_id: null, held_transmission: null, status: "error" },
				]);
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'send'`,
				).toEqual([{ status: "failed", error_code: "attachment_missing" }]);
				expect(
					yield* sql`SELECT type FROM events WHERE type IN ('run.released', 'turn.error') ORDER BY sequence`,
				).toEqual([{ type: "run.released" }, { type: "turn.error" }]);
			}).pipe(Effect.provide(layer)),
	);
	it.effect(
		"a preparation refusal for a stale claim cannot release or settle a current hold",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				const input = { sessionId: "session", runId: "run", commandId: "send" };
				yield* lifecycle.holdRun(input);
				expect(
					yield* lifecycle.releaseRun(
						{
							...input,
							runnerId: "runner",
							transmission: 1,
							reason: "NotSent",
						},
						() => Effect.void,
						{
							_tag: "failed",
							send: { ...input, requestSequence: 0, attempt: 0 },
							failure: {
								operation: "prepare adopted send",
								code: "attachment_missing",
								message: "Missing attachment",
							},
							observedAt: 1730,
						},
					),
				).toEqual({ released: false, stop: undefined });
				expect(
					yield* sql`SELECT runner_id, held_transmission, status FROM provider_runs WHERE id = 'run'`,
				).toEqual([
					{ runner_id: "runner", held_transmission: 1, status: "pending" },
				]);
				expect(
					yield* sql`SELECT type FROM events WHERE type IN ('run.released', 'turn.error')`,
				).toEqual([]);
			}).pipe(Effect.provide(layer)),
	);
	it.effect(
		"Covered places the user's message in its settlement transaction",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				yield* sql`UPDATE provider_command_outbox SET payload_json = '{"prompt":"text to place","inputId":"send"}' WHERE command_id = 'send'`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
				VALUES (2, 'stop', 'project', 'session', 'claude', 'end_session', '{"stop":{"owners":[{"runId":"run"}]}}', 'completed', 2, 2)`;
				expect(
					yield* lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
						observedAt: 1730,
					}),
				).toEqual({ _tag: "Covered" });
				expect(
					yield* sql`SELECT input_id FROM messages WHERE session_id = 'session' AND role = 'user'`,
				).toEqual([{ input_id: "send" }]);
				expect(
					yield* sql`SELECT run_id FROM turns WHERE session_id = 'session'`,
				).toEqual([{ run_id: "run" }]);
			}).pipe(Effect.provide(layer)),
	);
	for (const shown of [false, true])
		it.effect(
			`Exhausted places the message and restores its text, previously shown=${shown}`,
			() =>
				Effect.gen(function* () {
					const { sql, lifecycle, persist } = yield* setup;
					yield* sql`UPDATE provider_command_outbox SET payload_json = '{"prompt":"exhausted text","text":"exhausted text","inputId":"send"}' WHERE command_id = 'send'`;
					for (let transmission = 1; transmission <= 5; transmission++) {
						expect(
							yield* lifecycle.holdRun({
								sessionId: "session",
								runId: "run",
								commandId: "send",
							}),
						).toEqual({ _tag: "Held", runner: "runner", transmission });
						yield* lifecycle.releaseRun(
							{
								sessionId: "session",
								runId: "run",
								runnerId: "runner",
								commandId: "send",
								transmission,
								reason: "NotSent",
							},
							() => Effect.void,
						);
					}
					if (shown)
						yield* persist.persistUserMessage("session", "exhausted text", {
							inputId: "send",
							messageId: "send",
							runId: "run",
							provider: "claude",
						});
					expect(
						yield* lifecycle.holdRun({
							sessionId: "session",
							runId: "run",
							commandId: "send",
							observedAt: 1730,
						}),
					).toEqual({ _tag: "Exhausted" });
					expect(
						yield* sql`SELECT input_id FROM messages WHERE session_id = 'session' AND role = 'user'`,
					).toEqual([{ input_id: "send" }]);
					expect(
						yield* sql`SELECT text, updated_at FROM input_drafts WHERE draft_key = 'session'`,
					).toEqual([{ text: "exhausted text", updated_at: 1730 }]);
				}).pipe(Effect.provide(layer)),
		);
	for (const state of [
		"absent",
		"no-owner-send",
		"mismatched-command",
		"terminal",
	])
		it.effect(`returns Ended without a domain error for ${state}`, () =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				if (state === "no-owner-send")
					yield* sql`DELETE FROM provider_command_outbox`;
				if (state === "terminal")
					yield* sql`UPDATE provider_runs SET status = 'error' WHERE id = 'run'`;
				expect(
					yield* Effect.result(
						lifecycle.holdRun({
							sessionId: "session",
							runId: state === "absent" ? "absent" : "run",
							commandId: state === "mismatched-command" ? "other" : "send",
						}),
					),
				).toEqual(Result.succeed({ _tag: "Ended" }));
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'run.dispatched'`,
				).toEqual([]);
			}).pipe(Effect.provide(layer)),
		);
	it.effect("F47 returns Busy for an already held owner send", () =>
		Effect.gen(function* () {
			const { sql, lifecycle } = yield* setup;
			const input = { sessionId: "session", runId: "run", commandId: "send" };
			expect(yield* lifecycle.holdRun(input)).toEqual({
				_tag: "Held",
				runner: "runner",
				transmission: 1,
			});
			expect(yield* Effect.result(lifecycle.holdRun(input))).toEqual(
				Result.succeed({ _tag: "Busy" }),
			);
			expect(
				yield* sql`SELECT type FROM events WHERE type = 'run.dispatched'`,
			).toHaveLength(1);
		}).pipe(Effect.provide(layer)),
	);
	it.effect(
		"returns Cleaning for the oldest unretired candidate before predecessor selection",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle, receipts } = yield* setup;
				yield* receipts.register(
					"candidate-first",
					{ sessionId: "session" },
					"candidate",
				);
				yield* receipts.register(
					"candidate-second",
					{ sessionId: "session" },
					"candidate",
				);
				yield* sql`UPDATE claude_runner_cursors SET retired_at = 1000 WHERE runner_id = 'runner'`;
				expect(
					yield* lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
						observedAt: 1001,
					}),
				).toEqual({ _tag: "Cleaning", runner: "candidate-first" });
			}).pipe(Effect.provide(layer)),
	);
	it.effect(
		"returns the durable predecessor window without reconciler state",
		() =>
			Effect.gen(function* () {
				const { sql, lifecycle } = yield* setup;
				yield* sql`UPDATE claude_runner_cursors SET retired_at = 1000, stop_started_at = 1500 WHERE runner_id = 'runner'`;
				expect(
					yield* lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
						observedAt: 2000,
					}),
				).toEqual({
					_tag: "Unserved",
					predecessor: Option.some({ runner: "runner", until: 5500 }),
				});
				expect(
					yield* lifecycle.holdRun({
						sessionId: "session",
						runId: "run",
						commandId: "send",
						observedAt: 5500,
					}),
				).toEqual({ _tag: "Unserved", predecessor: Option.none() });
			}).pipe(Effect.provide(layer)),
	);
	it.effect(
		"register returns Lost when the serving slot or an unretired candidate wins",
		() =>
			Effect.gen(function* () {
				const { sql, receipts } = yield* setup;
				expect(
					yield* Effect.result(
						receipts.register("loser", { sessionId: "session" }, "serving"),
					),
				).toEqual(Result.succeed("Lost"));
				yield* receipts.register(
					"candidate",
					{ sessionId: "session" },
					"candidate",
				);
				yield* sql`UPDATE claude_runner_cursors SET retired_at = 1 WHERE runner_id = 'runner'`;
				expect(
					yield* Effect.result(
						receipts.register(
							"also-loser",
							{ sessionId: "session" },
							"serving",
						),
					),
				).toEqual(Result.succeed("Lost"));
				expect(
					yield* sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id IN ('loser', 'also-loser')`,
				).toEqual([]);
			}).pipe(Effect.provide(layer)),
	);
});
