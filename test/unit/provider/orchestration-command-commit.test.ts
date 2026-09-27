import { SqlClient } from "@effect/sql";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
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
			projectKey: "project-1",
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
				projectKey: "project-1",
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
const withRepository = <A, E>(
	body: (
		sql: SqlClient.SqlClient,
		repository: DurableCommandCommitRepository,
	) => Effect.Effect<A, E>,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return yield* body(sql, new DurableCommandCommitRepository(sql));
	}).pipe(Effect.provide(makePersistenceEffectLayer(":memory:")));

describe("DurableCommandCommitRepository", () => {
	it.effect(
		"commits command events, receipt, outbox, and meta atomically",
		() =>
			withRepository((sql, repository) =>
				Effect.gen(function* () {
					const stored = yield* repository.commit(commitInput());

					expect(stored).toHaveLength(1);
					expect(
						yield* sql`SELECT status, fingerprint_hash FROM command_receipts WHERE command_id = ${"cmd-1"}`,
					).toEqual([
						{ status: "side_effect_requested", fingerprint_hash: "sha256:abc" },
					]);
					expect(
						yield* sql`SELECT effect_type FROM provider_command_outbox WHERE request_sequence = ${1}`,
					).toEqual([{ effect_type: "send_turn" }]);
					expect(
						yield* sql`SELECT last_applied_sequence FROM provider_command_meta WHERE project_key = ${"project-1"}`,
					).toEqual([{ last_applied_sequence: 1 }]);
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
						) VALUES (1, 'cmd-1', 'project-1', 'session-1', 'claude',
							'send_turn', '{}', 'running', 1, 1000, 1000)`;

					const result = yield* Effect.either(
						repository.commit(commitInput({ requestSequence: 2, at: 2000 })),
					);

					expect(result._tag).toBe("Left");
					if (result._tag === "Left") {
						expect(result.left.message).toMatch(/already running/);
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

				const result = yield* Effect.either(
					repository.commit(commitInput({ events: [event, event] })),
				);

				expect(result._tag).toBe("Left");
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

				const result = yield* Effect.either(repository.commit(commitInput()));

				expect(result._tag).toBe("Left");
				expect(yield* sql`SELECT * FROM events`).toEqual([]);
				expect(yield* sql`SELECT * FROM command_receipts`).toEqual([]);
				expect(yield* sql`SELECT * FROM provider_command_outbox`).toEqual([]);
			}),
		),
	);
});
