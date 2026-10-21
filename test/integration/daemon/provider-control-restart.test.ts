import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderControlPayloadSchema } from "../../../src/lib/provider/orchestration-command-contracts.js";
import { controlFingerprintHash } from "../../../src/lib/provider/orchestration-command-fingerprint.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";
import { writeProviderCommandOutboxProof } from "../../helpers/provider-command-outbox-proof.js";

describe("durable answers across daemon replacement", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses) {
			await harness.dispose();
			harness.assertNoRunners();
		}
		harnesses.length = 0;
	});

	it.each([
		false,
		true,
	])("replays a predecessor Stop without changing its payload or fingerprint, pending=%s", async (pending) => {
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Pre-snapshot Stop retry");
		await browser.send(sessionId, "seed-completed-owner");
		const commandId = randomUUID();
		const db = new Database(harness.daemonStorePath());
		let passed = false;
		try {
			if (pending)
				db.exec(`CREATE TRIGGER hold_legacy_stop BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.command_id = '${commandId}' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
			);
			await harness.kill();
			// Model the predecessor's committed payload and matching immutable receipt.
			db.prepare(
				"UPDATE provider_command_outbox SET payload_json = json_remove(payload_json, '$.stop', '$.turnIds') WHERE command_id = ?",
			).run(commandId);
			const original = db
				.prepare(
					"SELECT payload_json FROM provider_command_outbox WHERE command_id = ?",
				)
				.get(commandId) as { payload_json: string };
			const payload = Schema.decodeSync(
				Schema.fromJsonString(ProviderControlPayloadSchema),
			)(original.payload_json);
			const fingerprint = controlFingerprintHash(payload);
			db.prepare(
				"UPDATE command_receipts SET fingerprint_hash = ? WHERE command_id = ?",
			).run(fingerprint, commandId);
			db.prepare(
				"UPDATE events SET data = json_remove(data, '$.stop', '$.turnIds') WHERE type = 'interrupt.requested' AND json_extract(metadata, '$.commandId') = ?",
			).run(commandId);
			if (pending) {
				db.prepare(
					"UPDATE provider_command_outbox SET status = 'pending' WHERE command_id = ?",
				).run(commandId);
				db.prepare(
					"UPDATE command_receipts SET status = 'side_effect_requested' WHERE command_id = ?",
				).run(commandId);
			}
			await harness.restart();
			const restored = await harness.connect(sessionId);
			void restored
				.send(sessionId, "upgrade-long-turn", 60_000)
				.catch(() => undefined);
			await vi.waitFor(
				() =>
					expect(
						readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8"),
					).toContain('"kind":"assistant-held"'),
				{ timeout: 15_000 },
			);
			if (pending) db.exec("DROP TRIGGER hold_legacy_stop");
			const outcome = await Effect.runPromise(
				Effect.result(restored.rpc.CancelSession({ sessionId, commandId })),
			);
			expect(outcome._tag).toBe("Success");
			expect(
				db
					.prepare(
						"SELECT payload_json FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(commandId),
			).toEqual(original);
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT fingerprint_hash, status FROM command_receipts WHERE command_id = ?",
							)
							.get(commandId),
					).toEqual({
						fingerprint_hash: fingerprint,
						status: "side_effect_completed",
					}),
				{ timeout: 10_000 },
			);
			if (pending) {
				const nativeCalls = readFileSync(
					join(harness.root, "sdk-proof.ndjson"),
					"utf8",
				);
				expect(nativeCalls.includes('"kind":"query-interrupted"')).toBe(false);
				expect(nativeCalls.includes('"kind":"query-closed"')).toBe(false);
			}
			expect(
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND type = 'interrupt.requested'",
					)
					.all(sessionId),
			).toHaveLength(1);
			expect(
				db
					.prepare(
						"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
					)
					.all(sessionId),
			).toEqual([{ status: "completed" }, { status: "running" }]);
			expect(
				db
					.prepare(
						"SELECT command_id FROM provider_command_outbox WHERE command_id = ?",
					)
					.all(`${commandId}:retire`),
			).toEqual([]);
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			await vi.waitFor(() =>
				expect(
					db
						.prepare(
							"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
						)
						.all(sessionId),
				).toEqual([{ status: "completed" }, { status: "completed" }]),
			);
			passed = true;
		} finally {
			writeProviderCommandOutboxProof(import.meta.url, [
				{
					scenario: pending
						? "legacy-empty-stop-pending-replay"
						: "legacy-stop-immutable-replay",
					passed,
					sessionId,
					commandId,
					commands: db
						.prepare(
							"SELECT command_id, effect_type, provider_process_id, run_id, payload_json, status FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
						)
						.all(sessionId),
					receipt: db
						.prepare(
							"SELECT fingerprint_hash, status FROM command_receipts WHERE command_id = ?",
						)
						.get(commandId),
					runs: db
						.prepare(
							"SELECT id, status FROM provider_runs WHERE session_id = ?",
						)
						.all(sessionId),
					events: db
						.prepare(
							"SELECT type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
						)
						.all(sessionId),
					nativeCalls: readFileSync(
						join(harness.root, "sdk-proof.ndjson"),
						"utf8",
					)
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as Record<string, unknown>)
						.filter((mark) =>
							["runner-control", "query-interrupted", "query-closed"].includes(
								String(mark["kind"]),
							),
						),
					restartMarks: harness.proof().generations,
				},
			]);
			db.close();
		}
	}, 90_000);

	it.each([
		{ died: false, claimed: false },
		{ died: true, claimed: false },
		{ died: false, claimed: true },
	])("committed answer survives restart, runner died=$died, claimed=$claimed", async ({
		died,
		claimed,
	}) => {
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Durable control restart");
		const send = browser
			.send(sessionId, "approval-restart")
			.catch(() => undefined);
		const request = await browser.waitFor(
			(frame) => frame["type"] === "permission_pending",
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started") throw new Error("Missing runner");
		const db = new Database(harness.daemonStorePath());
		try {
			// Stop on either side of delivery while retaining the committed command.
			db.exec(`CREATE TRIGGER hold_control BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.effect_type = 'resolve_permission' AND NEW.status = '${claimed ? "completed" : "running"}'
				BEGIN SELECT RAISE(IGNORE); END`);
			const answer = browser
				.answerApproval(request, "allow_always")
				.catch(() => undefined);
			await vi.waitFor(
				() => {
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'resolve_permission'",
							)
							.get(sessionId),
					).toEqual({ status: claimed ? "running" : "pending" });
					if (claimed)
						expect(
							readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8"),
						).toContain('"kind":"approval"');
				},
				{ timeout: 5000 },
			);
			const control = db
				.prepare(
					"SELECT command_id, provider_process_id, payload_json FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'resolve_permission'",
				)
				.get(sessionId) as {
				command_id: string;
				provider_process_id: string;
				payload_json: string;
			};
			expect(JSON.parse(control.payload_json)).toMatchObject({
				response: { permissionUpdates: [{ destination: "session" }] },
			});
			await harness.kill();
			await Promise.all([send, answer]);
			if (died) {
				process.kill(runner.pid, "SIGKILL");
				await vi.waitFor(() =>
					expect(() => process.kill(runner.pid, 0)).toThrow(),
				);
			}
			db.exec("DROP TRIGGER hold_control");
			await harness.restart();
			const after = await harness.connect(sessionId);
			await after.view(sessionId);
			await vi.waitFor(
				() => {
					expect(
						db
							.prepare(
								"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(control.command_id),
					).toEqual({
						status: died ? "cancelled" : "completed",
						error_code: died ? "provider_process_gone" : null,
					});
				},
				{ timeout: 15_000 },
			);
			const sdk = readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const deliveries = sdk.filter(
				(mark) =>
					mark["kind"] === "runner-control" &&
					mark["commandId"] === control.command_id,
			);
			expect(deliveries).toHaveLength(died ? 0 : 1);
			const approvals = sdk.filter((mark) => mark["kind"] === "approval");
			expect(approvals).toHaveLength(died ? 0 : 1);
			if (!died)
				expect(approvals[0]?.["updatedPermissions"]).toEqual([
					{
						type: "addRules",
						rules: [
							{ toolName: "Bash", ruleContent: "printf harness-approved" },
						],
						behavior: "allow",
						destination: "session",
					},
				]);
			if (!died) {
				await vi.waitFor(async () =>
					expect(JSON.stringify(await after.history(sessionId))).toContain(
						responseChunks("approval-restart").join(""),
					),
				);
			}
			mkdirSync("/tmp/conduit-82tn27-2", { recursive: true });
			writeFileSync(
				`/tmp/conduit-82tn27-2/answer-restart-${claimed ? "claimed" : died ? "dead" : "alive"}.json`,
				JSON.stringify(
					{
						sessionId,
						control,
						deliveries,
						outbox: db
							.prepare(
								"SELECT command_id, effect_type, status, error_code FROM provider_command_outbox WHERE session_id = ?",
							)
							.all(sessionId),
						receipts: db
							.prepare(
								"SELECT command_id, status, error_code FROM command_receipts WHERE session_id = ?",
							)
							.all(sessionId),
						process: harness.proof(),
					},
					null,
					2,
				),
			);
		} finally {
			mkdirSync("/tmp/conduit-82tn27-2", { recursive: true });
			writeFileSync(
				`/tmp/conduit-82tn27-2/answer-restart-${died ? "dead" : "alive"}-diagnostic.json`,
				JSON.stringify(
					{
						outbox: db
							.prepare(
								"SELECT command_id, provider_process_id, effect_type, status, error_code FROM provider_command_outbox WHERE session_id = ?",
							)
							.all(sessionId),
						receipts: db
							.prepare(
								"SELECT command_id, status, error_code, error FROM command_receipts WHERE session_id = ?",
							)
							.all(sessionId),
						prompts: db
							.prepare(
								"SELECT id, provider_process_id, status FROM pending_approvals WHERE session_id = ?",
							)
							.all(sessionId),
						process: harness.proof(),
						log: harness.logTail,
					},
					null,
					2,
				),
			);
			db.close();
		}
	}, 90_000);
});
