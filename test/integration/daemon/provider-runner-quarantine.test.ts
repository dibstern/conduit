import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { discoverRunners } from "../../../src/lib/provider/runner/runner-registry.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// A quarantined entry remains live but cannot accept controls. Its committed
// answer must finish with a durable reason instead of hanging or being delivered.
describe("durable controls on quarantined runners", () => {
	it("cancels an undelivered answer and ends its receipt when restart quarantines its live target", async () => {
		const harness = await ProcessHarness.start({ restartProof: true });
		const evidence: Record<string, unknown> = { passed: false };
		let db: Database.Database | undefined;
		try {
			const browser = await harness.connect();
			const sessionId = await browser.createSession("Quarantined control");
			const send = browser
				.send(sessionId, "approval-quarantined-control")
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
			if (!control) throw new Error("Missing committed answer");
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
			if (!runner) throw new Error("Missing target runner");
			// A surviving process whose socket was lost cannot be reattached.
			unlinkSync(runner.socketPath);
			store.exec("DROP TRIGGER hold_control");
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
						error_code: "provider_process_unavailable",
					});
					expect(
						store
							.prepare(
								"SELECT status, error_code, error FROM command_receipts WHERE command_id = ?",
							)
							.get(control.command_id),
					).toEqual({
						status: "side_effect_failed",
						error_code: "provider_process_unavailable",
						error: expect.stringContaining("target provider process"),
					});
				},
				{ timeout: 15_000 },
			);
			expect(harness.logTail).toContain(`Session ${sessionId} is quarantined`);
			expect(() => process.kill(runner.pid, 0)).not.toThrow();
			expect(
				store
					.prepare(
						"SELECT status, provider_process_id FROM pending_approvals WHERE id = 'other-live-question' AND session_id = ?",
					)
					.get(sessionId),
			).toEqual({
				status: "pending",
				provider_process_id: control.provider_process_id,
			});
			evidence["prompts"] = store
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
			mkdirSync("/tmp/conduit-82tn27-2", { recursive: true });
			writeFileSync(
				"/tmp/conduit-82tn27-2/quarantined-control.json",
				JSON.stringify(evidence, null, 2),
			);
			harness.assertNoRunners();
		}
	}, 60_000);
});
