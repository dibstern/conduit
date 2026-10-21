import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

describe("durable controls across daemon replacement", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses) {
			await harness.dispose();
			harness.assertNoRunners();
		}
		harnesses.length = 0;
	});

	it.each([
		{ delivered: false, replaced: false },
		{ delivered: true, replaced: false },
		{ delivered: false, replaced: true },
	])("retains an interrupted End across restart, delivered=$delivered, replaced=$replaced", async ({
		delivered,
		replaced,
	}) => {
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Durable End restart");
		await browser.send(sessionId, "before-retained-end");
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started") throw new Error("Missing runner");
		const db = new Database(harness.daemonStorePath());
		try {
			// Retain either an undelivered intent or an End whose runner has exited
			// before the daemon can record its outcome. For the replacement case,
			// also defer startup retirement until its new turn is already running.
			db.exec(`CREATE TRIGGER hold_end BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.effect_type = 'end_session' AND (NEW.status = '${delivered ? "completed" : "running"}'
					OR (${Number(replaced)} = 1 AND NEW.status = 'cancelled'))
				BEGIN SELECT RAISE(IGNORE); END`);
			const controller = new AbortController();
			const reload = browser.reloadSession(sessionId, controller.signal).then(
				() => "completed",
				() => "interrupted",
			);
			const ends = () =>
				db
					.prepare(
						"SELECT outbox.command_id, outbox.provider_process_id, outbox.status, outbox.attempt_count, outbox.error_code, receipt.status AS receipt_status, receipt.error_code AS receipt_error FROM provider_command_outbox outbox JOIN command_receipts receipt ON receipt.command_id = outbox.command_id AND receipt.project_key = outbox.project_key WHERE outbox.session_id = ? AND outbox.effect_type = 'end_session'",
					)
					.all(sessionId) as Array<{
					command_id: string;
					provider_process_id: string;
					status: string;
					attempt_count: number;
					error_code: string | null;
					receipt_status: string;
					receipt_error: string | null;
				}>;
			await vi.waitFor(
				() => {
					expect(ends()).toEqual([
						{
							command_id: expect.any(String),
							provider_process_id: expect.any(String),
							status: delivered ? "running" : "pending",
							attempt_count: delivered ? 1 : 0,
							error_code: null,
							receipt_status: "side_effect_requested",
							receipt_error: null,
						},
					]);
					if (delivered) expect(() => process.kill(runner.pid, 0)).toThrow();
				},
				{ timeout: 15_000 },
			);
			const end = ends()[0];
			if (!end) throw new Error("Missing End intent");
			expect(runner.socketPath.endsWith(`/${end.provider_process_id}`)).toBe(
				true,
			);
			controller.abort();
			expect(await reload).toBe("interrupted");
			expect(ends()).toEqual([end]);
			await harness.kill();
			if (replaced) {
				process.kill(runner.pid, "SIGKILL");
				await vi.waitFor(() =>
					expect(() => process.kill(runner.pid, 0)).toThrow(),
				);
			}
			if (!replaced) db.exec("DROP TRIGGER hold_end");
			await harness.restart();
			const after = await harness.connect(sessionId);
			const gone = delivered || replaced;
			const settledEnd = {
				...end,
				status: gone ? "cancelled" : "completed",
				attempt_count: 1,
				error_code: gone ? "provider_process_gone" : null,
				receipt_status: gone ? "side_effect_failed" : "side_effect_completed",
				receipt_error: gone ? "provider_process_gone" : null,
			};
			// On the surviving target, finish replay before submitting more work.
			// Only the replacement case intentionally overlaps a new send with End.
			if (!replaced)
				await vi.waitFor(() => expect(ends()).toEqual([settledEnd]), {
					timeout: 15_000,
				});
			const prompt = replaced
				? "approval-after-retained-end"
				: "after-retained-end";
			// Hold the replacement's turn open so the old End must settle while a
			// new runner owns both a live send and a pending approval.
			const send = after.send(sessionId, prompt);
			void send.catch(() => undefined);
			let replacementPid: number | undefined;
			if (replaced) {
				const request = await after.waitFor(
					(frame) => frame["type"] === "permission_pending",
				);
				const replacement = harness.marks
					.filter((mark) => mark.kind === "runner-started")
					.at(-1);
				if (replacement?.kind !== "runner-started")
					throw new Error("Missing replacement runner");
				replacementPid = replacement.pid;
				expect(replacementPid).not.toBe(runner.pid);
				expect(ends()).toEqual([end]);
				db.exec("DROP TRIGGER hold_end");
				await vi.waitFor(() => expect(ends()[0]?.status).toBe("cancelled"), {
					timeout: 15_000,
				});
				expect(() => process.kill(replacement.pid, 0)).not.toThrow();
				expect(
					db
						.prepare(
							"SELECT status FROM pending_approvals WHERE session_id = ?",
						)
						.all(sessionId),
				).toEqual([{ status: "pending" }]);
				await after.answerApproval(request, "allow");
			}
			const result = await send;
			expect(result.done["status"]).toBe("idle");
			expect(result.chunks.join("")).toBe(responseChunks(prompt).join(""));
			await vi.waitFor(
				() => {
					expect(ends()).toEqual([settledEnd]);
					expect(
						db
							.prepare("SELECT status FROM sessions WHERE id = ?")
							.get(sessionId),
					).toEqual({ status: "idle" });
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
							)
							.all(sessionId),
					).toEqual([{ status: "completed" }, { status: "completed" }]);
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
					mark["commandId"] === end.command_id,
			);
			expect(deliveries).toEqual(
				replaced
					? []
					: [
							{
								kind: "runner-control",
								commandId: end.command_id,
								type: "end-session",
								runnerId: end.provider_process_id,
							},
						],
			);
			const replacement = harness.marks
				.filter((mark) => mark.kind === "runner-started")
				.at(-1);
			if (replacement?.kind !== "runner-started")
				throw new Error("Missing replacement runner");
			expect(replacement.pid).not.toBe(runner.pid);
			if (replacementPid !== undefined)
				expect(replacement.pid).toBe(replacementPid);
			// A terminal End must stay terminal on another recovery sweep.
			const settled = ends();
			await harness.kill();
			await harness.restart();
			const recovered = await harness.connect(sessionId);
			await recovered.send(sessionId, "after-end-recovery");
			expect(ends()).toEqual(settled);
			expect(
				harness.marks.filter((mark) => mark.kind === "runner-started").at(-1),
			).toMatchObject({ pid: replacement.pid });
			mkdirSync("/tmp/82tn-beads/end-diagnosis", { recursive: true });
			writeFileSync(
				`/tmp/82tn-beads/end-diagnosis/end-restart-${delivered ? "delivered" : replaced ? "replaced" : "pending"}.json`,
				JSON.stringify(
					{ sessionId, end, settled, deliveries, process: harness.proof() },
					null,
					2,
				),
			);
		} finally {
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
