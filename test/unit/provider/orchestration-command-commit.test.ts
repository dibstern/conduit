import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	type DurableCommandCommitInput,
	DurableCommandCommitRepository,
} from "../../../src/lib/provider/orchestration-command-commit.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

function commitInput(
	overrides: Partial<DurableCommandCommitInput> & {
		readonly requestSequence?: number;
		readonly at?: number;
	} = {},
): DurableCommandCommitInput {
	const at = overrides.at ?? 1000;
	return {
		events: overrides.events ?? [makeSessionCreatedEvent("session-1")],
		receipt: {
			commandId: "cmd-1",
			commandType: "send_turn",
			sessionId: "session-1",
			status: "side_effect_requested",
			fingerprintHash: "sha256:abc",
			fingerprintVersion: 2,
			acceptedSequence: 1,
			sideEffectSequence: 1,
			createdAt: at,
			updatedAt: at,
		},
		outboxRequests: [
			{
				requestSequence: overrides.requestSequence ?? 1,
				commandId: "cmd-1",
				sessionId: "session-1",
				providerId: "claude",
				effectType: "send_turn",
				payloadJson: "{}",
			},
		],
		readModelRows: ["provider_command_meta"],
	};
}

/** Every test gets a fresh migrated in-memory database. */
const withRepository = <A, E, R>(
	body: (
		sql: SqlClient.SqlClient,
		repository: DurableCommandCommitRepository,
	) => Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return yield* body(
			sql,
			new DurableCommandCommitRepository(sql, "test-project"),
		);
	}).pipe(
		Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
	);

describe("DurableCommandCommitRepository", () => {
	it.effect(
		"reuses a pending reservation when replacing an unclaimed outbox row",
		() =>
			withRepository((sql, repository) =>
				Effect.gen(function* () {
					const runner = yield* ProjectionRunnerEffectTag;
					yield* runner.recover();
					yield* runner.projectBatch(yield* repository.commit(commitInput()));
					const [first] = yield* sql<{
						id: string;
					}>`SELECT id FROM provider_runs`;
					const stored = yield* repository.commit(
						commitInput({ events: [], requestSequence: 2, at: 2000 }),
					);
					yield* runner.projectBatch(stored);
					expect(yield* sql`SELECT id, status FROM provider_runs`).toEqual([
						{ id: first?.id, status: "pending" },
					]);
					expect(
						yield* sql`SELECT request_sequence, run_id FROM provider_command_outbox`,
					).toEqual([{ request_sequence: 2, run_id: first?.id }]);
					expect(stored).toEqual([]);
					expect(
						yield* sql`SELECT last_applied_sequence FROM provider_command_meta`,
					).toEqual([{ last_applied_sequence: 2 }]);
				}),
			),
	);

	it.effect(
		"reserves a live initial owner when an ended send is recommitted",
		() =>
			withRepository((sql, repository) =>
				Effect.gen(function* () {
					const runner = yield* ProjectionRunnerEffectTag;
					yield* runner.recover();
					yield* runner.projectBatch(yield* repository.commit(commitInput()));
					const [first] = yield* sql<{
						id: string;
					}>`SELECT id FROM provider_runs`;
					if (!first) throw new Error("Initial reservation missing");
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent(
							"turn.error",
							"session-1",
							{
								messageId: "",
								error: "retry",
								retryable: true,
							},
							{
								provider: "claude",
								createdAt: 1500,
								metadata: { runId: first.id },
							},
						),
					]);
					const stored = yield* repository.commit(
						commitInput({ events: [], requestSequence: 4, at: 2000 }),
					);
					yield* runner.projectBatch(stored);
					const [current] = yield* sql<{
						run_id: string;
					}>`SELECT run_id FROM provider_command_outbox WHERE request_sequence = 4`;
					expect(current?.run_id).not.toBe(first?.id);
					expect(
						yield* sql`SELECT status FROM provider_runs WHERE id = ${first?.id}`,
					).toEqual([{ status: "error" }]);
					expect(
						yield* sql`SELECT status FROM provider_runs WHERE id = ${current?.run_id}`,
					).toEqual([{ status: "pending" }]);
					expect(stored).toContainEqual(
						expect.objectContaining({
							type: "run.requested",
							data: { runId: current?.run_id, inputId: "cmd-1" },
						}),
					);
				}),
			),
	);

	it.effect(
		"reserves a run with its send and rolls it back with failed commits",
		() =>
			withRepository((sql, repository) =>
				Effect.gen(function* () {
					const runner = yield* ProjectionRunnerEffectTag;
					yield* runner.recover();
					const stored = yield* repository.commit(commitInput());
					expect(yield* sql`SELECT id FROM provider_runs`).toEqual([]);
					yield* runner.projectBatch(stored);
					const [request] = yield* sql<{
						payload_json: string;
						run_id: string;
					}>`
					SELECT payload_json, run_id FROM provider_command_outbox WHERE command_id = 'cmd-1'`;
					const payload: unknown = JSON.parse(request?.payload_json ?? "null");
					expect(payload).toEqual({});
					expect(request?.run_id).toEqual(expect.any(String));
					const [run] = yield* sql<{
						id: string;
						status: string;
						session_id: string;
					}>`
					SELECT id, status, session_id FROM provider_runs`;
					expect(run).toEqual({
						id: expect.any(String),
						status: "pending",
						session_id: "session-1",
					});
					expect(request?.run_id).toBe(run?.id);
					expect(stored).toContainEqual(
						expect.objectContaining({
							type: "run.requested",
							metadata: { runId: run?.id },
							data: { runId: run?.id, inputId: "cmd-1" },
						}),
					);
					yield* sql`CREATE TRIGGER fail_receipt_write BEFORE INSERT ON command_receipts
					BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END`;
					const input = commitInput({ requestSequence: 2 });
					const failed = yield* Effect.result(
						repository.commit({
							...input,
							events: [],
							receipt: { ...input.receipt, commandId: "cmd-2" },
							outboxRequests: input.outboxRequests.map((request) => ({
								...request,
								commandId: "cmd-2",
							})),
						}),
					);
					expect(failed._tag).toBe("Failure");
					expect(yield* sql`SELECT id FROM provider_runs`).toEqual([
						{ id: run?.id },
					]);
				}),
			),
	);
	// A caller may reuse a command id across projects whose session ids differ.
	// Neither the receipt upsert nor idle-claim replacement may move B's rows.
	it.effect("rejects a command id already owned by another project", () =>
		withRepository((sql, repository) =>
			Effect.gen(function* () {
				const input = commitInput();
				const foreign = new DurableCommandCommitRepository(sql, "project-b");
				yield* foreign.commit({
					...input,
					events: [makeSessionCreatedEvent("session-b")],
					receipt: { ...input.receipt, sessionId: "session-b" },
					outboxRequests: input.outboxRequests.map((request) => ({
						...request,
						sessionId: "session-b",
					})),
				});
				const before = JSON.stringify({
					receipts: yield* sql`SELECT * FROM command_receipts`,
					outbox: yield* sql`SELECT * FROM provider_command_outbox`,
				});
				const result = yield* Effect.result(
					repository.commit(commitInput({ requestSequence: 2, at: 2000 })),
				);
				expect(result._tag).toBe("Failure");
				expect(
					JSON.stringify({
						receipts: yield* sql`SELECT * FROM command_receipts`,
						outbox: yield* sql`SELECT * FROM provider_command_outbox`,
					}),
				).toBe(before);
				expect(
					yield* sql`SELECT id FROM sessions WHERE id = 'session-1'`,
				).toEqual([]);
			}),
		),
	);

	it.effect("rejects a foreign outbox claim even without its receipt", () =>
		withRepository((sql, repository) =>
			Effect.gen(function* () {
				yield* sql`INSERT INTO provider_command_outbox (
					request_sequence, command_id, project_key, session_id, provider_id,
					effect_type, payload_json, status, attempt_count, requested_at, updated_at
				) VALUES (1, 'cmd-1', 'project-b', 'session-b', 'claude',
					'send_turn', '{}', 'pending', 0, 1000, 1000)`;
				const before = JSON.stringify(
					yield* sql`SELECT * FROM provider_command_outbox`,
				);
				const result = yield* Effect.result(
					repository.commit(commitInput({ requestSequence: 2, at: 2000 })),
				);
				expect(result._tag).toBe("Failure");
				expect(
					JSON.stringify(yield* sql`SELECT * FROM provider_command_outbox`),
				).toBe(before);
				expect(yield* sql`SELECT * FROM command_receipts`).toEqual([]);
				expect(yield* sql`SELECT * FROM events`).toEqual([]);
			}),
		),
	);

	it.effect(
		"commits command events, receipt, outbox, and meta atomically",
		() =>
			withRepository((sql, repository) =>
				Effect.gen(function* () {
					const stored = yield* repository.commit(commitInput());

					expect(stored).toHaveLength(2);
					expect(
						yield* sql`SELECT status, fingerprint_hash FROM command_receipts WHERE command_id = ${"cmd-1"}`,
					).toEqual([
						{ status: "side_effect_requested", fingerprint_hash: "sha256:abc" },
					]);
					expect(
						yield* sql`SELECT effect_type FROM provider_command_outbox WHERE request_sequence = ${1}`,
					).toEqual([{ effect_type: "send_turn" }]);
					expect(
						yield* sql`SELECT last_applied_sequence FROM provider_command_meta WHERE project_key = ${"test-project"}`,
					).toEqual([{ last_applied_sequence: 2 }]);
				}),
			),
	);

	it.effect(
		"refuses to recommit a command while an execution claim is already running",
		() =>
			withRepository((sql, repository) =>
				Effect.gen(function* () {
					// An executor (e.g. a background drain) has already claimed the row:
					// status = 'running'. A concurrent redispatch must NOT supersede this
					// live claim and insert a competing pending row, or the provider would
					// be invoked a second time. The recommit must fail and roll back.
					yield* sql`
						INSERT INTO provider_command_outbox (
							request_sequence, command_id, project_key, session_id, provider_id,
							effect_type, payload_json, status, attempt_count, requested_at, updated_at
						) VALUES (1, 'cmd-1', 'test-project', 'session-1', 'claude',
							'send_turn', '{}', 'running', 1, 1000, 1000)`;

					const result = yield* Effect.result(
						repository.commit(commitInput({ requestSequence: 2, at: 2000 })),
					);

					expect(result._tag).toBe("Failure");
					if (result._tag === "Failure") {
						expect(result.failure.message).toMatch(/already running/);
					}
					// The live running claim survives untouched; no competing pending row
					// was inserted; the whole commit (receipt included) rolled back.
					expect(
						yield* sql`
							SELECT request_sequence, status FROM provider_command_outbox
							WHERE command_id = ${"cmd-1"} ORDER BY request_sequence`,
					).toEqual([{ request_sequence: 1, status: "running" }]);
					expect(yield* sql`SELECT * FROM command_receipts`).toEqual([]);
					expect(yield* sql`SELECT * FROM events`).toEqual([]);
				}),
			),
	);

	it.effect("rolls back every durable row when any write fails", () =>
		withRepository((sql, repository) =>
			Effect.gen(function* () {
				const event = makeSessionCreatedEvent("session-1");

				const result = yield* Effect.result(
					repository.commit(commitInput({ events: [event, event] })),
				);

				expect(result._tag).toBe("Failure");
				expect(yield* sql`SELECT * FROM events`).toEqual([]);
				expect(yield* sql`SELECT * FROM command_receipts`).toEqual([]);
				expect(yield* sql`SELECT * FROM provider_command_outbox`).toEqual([]);
				expect(yield* sql`SELECT * FROM provider_command_meta`).toEqual([]);
			}),
		),
	);

	it.effect("rolls back appended events when the receipt write fails", () =>
		withRepository((sql, repository) =>
			Effect.gen(function* () {
				yield* sql`
					CREATE TRIGGER fail_receipt_write BEFORE INSERT ON command_receipts
					BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END`;

				const result = yield* Effect.result(repository.commit(commitInput()));

				expect(result._tag).toBe("Failure");
				expect(yield* sql`SELECT * FROM events`).toEqual([]);
				expect(yield* sql`SELECT * FROM command_receipts`).toEqual([]);
				expect(yield* sql`SELECT * FROM provider_command_outbox`).toEqual([]);
			}),
		),
	);
});
