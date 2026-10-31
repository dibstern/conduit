import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { discoverRunners } from "../../../src/lib/provider/runner/runner-registry.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

// A retired process cannot receive controls. Committed answers for that exact
// owner fail durably while a later send can use a fresh runner.
describe("durable controls on retired runners", () => {
	it("cancels an undelivered answer when restart retires its target and allows a replacement", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
		});
		const evidence: Record<string, unknown> = { passed: false };
		let db: Database.Database | undefined;
		try {
			const browser = await harness.connect();
			const sessionId = await browser.createSession("Retired control");
			const send = browser
				.send(sessionId, "approval-retired-control")
				.catch(() => undefined);
			const request = await browser.waitFor(
				(frame) => frame["type"] === "permission_pending",
			);
			db = new Database(harness.daemonStorePath());
			const store = db;
			store.exec(`CREATE TRIGGER hold_control BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.effect_type = 'resolve_permission' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			const answer = browser
				.answerApproval(request, "allow")
				.catch(() => undefined);
			const controlQuery = store.prepare<
				[string],
				{
					command_id: string;
					provider_process_id: string;
					status: string;
				}
			>(
				"SELECT command_id, provider_process_id, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'resolve_permission'",
			);
			await vi.waitFor(() =>
				expect(controlQuery.get(sessionId)?.status).toBe("pending"),
			);
			const control = controlQuery.get(sessionId);
			assert(control, "Missing committed answer");
			store
				.prepare(`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, provider_request_id, created_at)
				VALUES ('other-live-question', ?, 'question', 'pending', ?, 'native-other-question', 1)`)
				.run(sessionId, control.provider_process_id);
			evidence["control"] = control;
			await harness.kill();
			await Promise.all([send, answer]);
			const runner = discoverRunners(
				harness.projectDir,
				harness.configDir,
			).find((entry) => entry.runnerId === control.provider_process_id);
			assert(runner, "Missing target runner");
			// A surviving process whose socket was lost cannot be reattached.
			unlinkSync(runner.socketPath);
			store.exec("DROP TRIGGER hold_control");
			// The retirement row is pruned once the stopped process is gone, so
			// record it as its Stop escalates.
			store.exec(`CREATE TABLE runner_stops (runner_id TEXT, retired INTEGER, attachment_id TEXT, pid INTEGER);
				CREATE TRIGGER record_runner_stop AFTER UPDATE OF stop_state ON claude_runner_cursors
				WHEN NEW.stop_state = 'Escalating' AND OLD.stop_state <> 'Escalating'
				BEGIN INSERT INTO runner_stops VALUES (NEW.runner_id, NEW.retired_at IS NOT NULL, NEW.attachment_id, NEW.pid); END`);
			await harness.restart();
			await vi.waitFor(
				() => {
					expect(
						store
							.prepare(
								"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(control.command_id),
					).toEqual({
						status: "cancelled",
						error_code: "provider_process_gone",
					});
					expect(
						store
							.prepare(
								"SELECT status, error_code, error FROM command_receipts WHERE command_id = ?",
							)
							.get(control.command_id),
					).toEqual({
						status: "side_effect_failed",
						error_code: "provider_process_gone",
						error: expect.any(String),
					});
				},
				{ timeout: 15_000 },
			);
			expect(harness.logTail).toContain("Retired surviving runner");
			await vi.waitFor(() =>
				expect(
					store
						.prepare(
							"SELECT runner_id, retired, attachment_id, pid FROM runner_stops",
						)
						.all(),
				).toEqual([
					{
						runner_id: runner.runnerId,
						retired: 1,
						attachment_id: "",
						pid: runner.pid,
					},
				]),
			);
			// Recovery stops the disconnected survivor and kills its verified process.
			// Its run stays active until Gone, after the reaper exits too, settles it
			// and prunes the row (C 6.5, 6.6, 6.8). A message sent sooner queues
			// behind that run and its failure pauses the queue, as on main.
			await vi.waitFor(
				() => {
					expect(() => process.kill(runner.pid, 0)).toThrow();
					expect(
						store
							.prepare(
								"SELECT 1 FROM claude_runner_cursors WHERE runner_id = ?",
							)
							.get(runner.runnerId),
					).toBeUndefined();
				},
				{
					timeout: 10_000,
				},
			);
			evidence["promptsBeforeReplacement"] = store
				.prepare(
					"SELECT id, status, provider_process_id FROM pending_approvals WHERE session_id = ? ORDER BY id",
				)
				.all(sessionId);
			const sdk = readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const deliveries = sdk.filter(
				(mark) =>
					mark["kind"] === "runner-control" &&
					mark["commandId"] === control.command_id,
			);
			expect(deliveries).toEqual([]);
			expect(sdk.filter((mark) => mark["kind"] === "approval")).toEqual([]);
			const restored = await harness.connect(sessionId);
			expect(
				(await restored.send(sessionId, "after-retired-control")).chunks.join(
					"",
				),
			).toBe(responseChunks("after-retired-control").join(""));
			const replacement = discoverRunners(
				harness.projectDir,
				harness.configDir,
			).find(
				(entry) =>
					entry.sessionId === sessionId && entry.runnerId !== runner.runnerId,
			);
			assert(replacement);
			expect(replacement.pid).not.toBe(runner.pid);
			expect(
				store
					.prepare(
						"SELECT status, provider_process_id FROM pending_approvals WHERE id = 'other-live-question' AND session_id = ?",
					)
					.get(sessionId),
			).toEqual({
				status: "resolved",
				provider_process_id: control.provider_process_id,
			});
			evidence["deliveries"] = deliveries;
			evidence["outbox"] = store
				.prepare(
					"SELECT command_id, status, error_code FROM provider_command_outbox WHERE session_id = ?",
				)
				.all(sessionId);
			evidence["receipts"] = store
				.prepare(
					"SELECT command_id, status, error_code, error FROM command_receipts WHERE session_id = ?",
				)
				.all(sessionId);
			evidence["passed"] = true;
		} catch (cause) {
			evidence["error"] = String(cause);
			throw cause;
		} finally {
			db?.close();
			evidence["proof"] = harness.proof();
			evidence["logTail"] = harness.logTail;
			await harness.dispose();
			evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
			mkdirSync("test-results/82tn-32-16", { recursive: true });
			writeFileSync(
				"test-results/82tn-32-16/retired-control.json",
				JSON.stringify(evidence, null, 2),
			);
			harness.assertNoRunners();
		}
	}, 60_000);
});
