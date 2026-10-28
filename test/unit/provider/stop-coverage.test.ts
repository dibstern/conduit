import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { DurableCommandCommitRepository } from "../../../src/lib/provider/orchestration-command-commit.js";
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";
import { stopCovers } from "../../../src/lib/provider/session-run-settlement.js";

const layer = makePersistenceEffectLayer(":memory:", "project");

// A recommit can move request_sequence past Stop, while a later joined steer
// must not inherit the owner's coverage. Only old controls use outbox order.
describe("Stop coverage", () => {
	for (const control of ["retire", "reload", "interrupt"] as const)
		it.effect(
			`does not cover M2 sent after Stop when ${control} commits while stopping`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("session.created", "session", {
							sessionId: "session",
							title: "session",
							provider: "claude",
						}),
						...(["R1", "R2"] as const).map((runId) =>
							canonicalEvent(
								"run.requested",
								"session",
								{ runId, inputId: runId },
								{
									provider: "claude",
									metadata: { runId },
								},
							),
						),
					]);
					const repository = new DurableCommandCommitRepository(sql, "project");
					const snapshot = {
						owners: [{ runId: "R1" }],
						turnIds: ["R1"],
						deadlineAt: 3000,
						runnerBacked: true,
						retainedSteers: false,
					};
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
						VALUES (1, 'M1', 'project', 'session', 'claude', 'send_turn', '{}', 'R1', 'running', 1, 1)`;
					yield* repository.commitControl({
						commandId: "stop",
						providerId: "claude",
						fingerprintHash: "stop",
						requestSequence: 2,
						nowMs: 2,
						payload: {
							type: "interrupt_turn",
							sessionId: "session",
							providerProcessId: "old",
							turnIds: ["R1"],
							stop: snapshot,
						},
					});
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
						VALUES (3, 'M2', 'project', 'session', 'claude', 'send_turn', '{}', 'R2', 'running', 3, 3)`;
					yield* repository.commitControl({
						commandId: control,
						providerId: "claude",
						fingerprintHash: control,
						requestSequence: 4,
						nowMs: 4,
						payload:
							control === "interrupt"
								? {
										type: "interrupt_turn",
										sessionId: "session",
										providerProcessId: "old",
										turnIds: ["M2"],
									}
								: {
										type: "end_session",
										sessionId: "session",
										providerProcessId: "old",
										...(control === "retire"
											? { retireProcess: true, retireRunIds: ["R1"] }
											: {}),
									},
					});
					const receipts = yield* makeRunnerReceiptStore(sql);
					yield* receipts.register(
						"fresh",
						{ sessionId: "session", pid: 100, startTime: "start" },
						"serving",
					);
					expect(
						yield* commit.holdRun({
							sessionId: "session",
							runId: "R2",
							commandId: "M2",
						}),
					).toEqual({ _tag: "Held", runner: "fresh", transmission: 1 });
					expect(yield* stopCovers(sql, "session", "R1")).toBe(true);
					expect(yield* stopCovers(sql, "session", "R2")).toBe(false);
					expect(
						yield* sql`SELECT json_type(payload_json, '$.stop') AS marker FROM provider_command_outbox WHERE command_id = ${control}`,
					).toEqual([{ marker: "null" }]);
					expect(
						yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'turn.interrupted'`,
					).toEqual([{ n: 0 }]);
				}).pipe(Effect.provide(layer)),
		);
	it.effect("keeps a recommitted send covered by its immutable cohort", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('run', 'session', 'pending', 1)`;
			yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
				VALUES (1, 'stop', 'project', 'session', 'claude', 'end_session', '{"stop":{"owners":[{"runId":"run"}]}}', NULL, 'completed', 1, 1),
				(2, 'send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1)`;
			expect(yield* stopCovers(sql, "session", "run")).toBe(true);
		}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"never widens a new cohort through legacy ordering or a later join",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at, joined_into)
				VALUES ('owner', 'session', 'running', 1, NULL), ('later-steer', 'session', 'pending', 1, 'owner')`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
				VALUES (1, 'send', 'project', 'session', 'claude', 'send_turn', '{}', 'later-steer', 'running', 1, 1),
				(2, 'stop', 'project', 'session', 'claude', 'end_session', '{"stop":{"owners":[{"runId":"owner"}]}}', NULL, 'completed', 1, 1)`;
				expect(yield* stopCovers(sql, "session", "owner")).toBe(true);
				expect(yield* stopCovers(sql, "session", "later-steer")).toBe(false);
				expect(yield* stopCovers(sql, "other-session", "owner")).toBe(false);
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"retains read-only legacy control coverage beside a newer empty cohort",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('run', 'session', 'running', 1)`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at)
				VALUES (1, 'send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1),
				(2, 'old-stop', 'project', 'session', 'claude', 'end_session', '{}', NULL, 'completed', 1, 1),
				(3, 'new-stop', 'project', 'session', 'claude', 'end_session', '{"stop":{"owners":[]}}', NULL, 'completed', 1, 1)`;
				expect(yield* stopCovers(sql, "session", "run")).toBe(true);
				yield* sql`DELETE FROM provider_command_outbox WHERE command_id = 'old-stop'`;
				expect(yield* stopCovers(sql, "session", "run")).toBe(false);
			}).pipe(Effect.provide(layer)),
	);
});
