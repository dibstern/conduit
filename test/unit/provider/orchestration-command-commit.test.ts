import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { DurableCommandCommitRepository } from "../../../src/lib/provider/orchestration-command-commit.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

describe("DurableCommandCommitRepository", () => {
	let db: SqliteClient;
	let repository: DurableCommandCommitRepository;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		repository = new DurableCommandCommitRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	it("commits command events, receipt, outbox, and meta atomically", () => {
		const stored = repository.commit({
			events: [makeSessionCreatedEvent("session-1")],
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
				createdAt: 1000,
				updatedAt: 1000,
			},
			outboxRequests: [
				{
					requestSequence: 1,
					commandId: "cmd-1",
					projectKey: "project-1",
					sessionId: "session-1",
					providerId: "claude",
					effectType: "send_turn",
					payloadJson: "{}",
				},
			],
			readModelRows: ["provider_command_meta"],
		});

		expect(stored).toHaveLength(1);
		expect(
			db.queryOne<{ status: string; fingerprint_hash: string }>(
				"SELECT status, fingerprint_hash FROM command_receipts WHERE command_id = ?",
				["cmd-1"],
			),
		).toEqual({
			status: "side_effect_requested",
			fingerprint_hash: "sha256:abc",
		});
		expect(
			db.queryOne<{ effect_type: string }>(
				"SELECT effect_type FROM provider_command_outbox WHERE request_sequence = ?",
				[1],
			),
		).toEqual({ effect_type: "send_turn" });
		expect(
			db.queryOne<{ last_applied_sequence: number }>(
				"SELECT last_applied_sequence FROM provider_command_meta WHERE project_key = ?",
				["project-1"],
			),
		).toEqual({ last_applied_sequence: 1 });
	});

	it("refuses to recommit a command while an execution claim is already running", () => {
		// An executor (e.g. a background drain) has already claimed the row:
		// status = 'running'. A concurrent redispatch must NOT supersede this live
		// claim and insert a competing pending row, or the provider would be
		// invoked a second time. The recommit must fail and roll back.
		db.execute(
			`INSERT INTO provider_command_outbox (
				request_sequence, command_id, project_key, session_id, provider_id,
				effect_type, payload_json, status, attempt_count, requested_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 1, ?, ?)`,
			[
				1,
				"cmd-1",
				"project-1",
				"session-1",
				"claude",
				"send_turn",
				"{}",
				1000,
				1000,
			],
		);

		expect(() =>
			repository.commit({
				events: [makeSessionCreatedEvent("session-1")],
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
					createdAt: 2000,
					updatedAt: 2000,
				},
				outboxRequests: [
					{
						requestSequence: 2,
						commandId: "cmd-1",
						projectKey: "project-1",
						sessionId: "session-1",
						providerId: "claude",
						effectType: "send_turn",
						payloadJson: "{}",
					},
				],
				readModelRows: ["provider_command_meta"],
			}),
		).toThrow(/already running/);

		// The live running claim survives untouched; no competing pending row was
		// inserted; the whole commit (receipt included) rolled back.
		expect(
			db.query<{ request_sequence: number; status: string }>(
				`SELECT request_sequence, status FROM provider_command_outbox
				 WHERE command_id = ? ORDER BY request_sequence`,
				["cmd-1"],
			),
		).toEqual([{ request_sequence: 1, status: "running" }]);
		expect(db.query("SELECT * FROM command_receipts")).toEqual([]);
	});

	it("rolls back every durable row when any write fails", () => {
		const event = makeSessionCreatedEvent("session-1");

		expect(() =>
			repository.commit({
				events: [event, event],
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
					createdAt: 1000,
					updatedAt: 1000,
				},
				outboxRequests: [
					{
						requestSequence: 1,
						commandId: "cmd-1",
						projectKey: "project-1",
						sessionId: "session-1",
						providerId: "claude",
						effectType: "send_turn",
						payloadJson: "{}",
					},
				],
				readModelRows: ["provider_command_meta"],
			}),
		).toThrow();

		expect(db.query("SELECT * FROM events")).toEqual([]);
		expect(db.query("SELECT * FROM command_receipts")).toEqual([]);
		expect(db.query("SELECT * FROM provider_command_outbox")).toEqual([]);
		expect(db.query("SELECT * FROM provider_command_meta")).toEqual([]);
	});
});
