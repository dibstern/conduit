import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Schema } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderStopSnapshot } from "../../../src/lib/contracts/stored-event.js";
import { ProviderControlPayloadSchema } from "../../../src/lib/provider/orchestration-command-contracts.js";
import { controlFingerprintHash } from "../../../src/lib/provider/orchestration-command-fingerprint.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { writeProviderCommandOutboxProof } from "../../helpers/provider-command-outbox-proof.js";

const recoveryEvidence: Record<string, unknown>[] = [];

afterAll(() =>
	writeProviderCommandOutboxProof(import.meta.url, recoveryEvidence),
);

function sdkProof(harness: ProcessHarness) {
	return readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Stop waits for provider confirmation", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			const runnersLog = join(harness.configDir, "runners.log");
			writeFileSync(
				`/tmp/82tn27-3-confirmation-${harness.root.split("/").at(-1)}.json`,
				JSON.stringify(
					{
						processProof: harness.proof(),
						runnersLog: existsSync(runnersLog)
							? readFileSync(runnersLog, "utf8").slice(-12_000)
							: null,
					},
					null,
					2,
				),
			);
			await harness.dispose();
			harness.assertNoRunners();
		}
	});

	it("a silent SDK interrupt leaves the turn running and natural completion wins", async () => {
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Silent Stop");
		const send = browser
			.send(sessionId, "upgrade-long-turn")
			.catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "assistant-held"),
				).toBe(true),
			{ timeout: 15_000 },
		);
		const db = new Database(harness.daemonStorePath());
		try {
			const stop = Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId: randomUUID() }),
			).catch(() => undefined);
			await vi.waitFor(() =>
				expect(
					sdkProof(harness).some(
						(mark) => mark["kind"] === "query-interrupted",
					),
				).toBe(true),
			);
			expect(
				db
					.prepare("SELECT status FROM provider_runs WHERE session_id = ?")
					.all(sessionId),
			).toEqual([{ status: "running" }]);
			expect(
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND type = 'turn.interrupted'",
					)
					.all(sessionId),
			).toEqual([]);
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			await Promise.all([send, stop]);
			await vi.waitFor(() =>
				expect(
					db
						.prepare("SELECT status FROM provider_runs WHERE session_id = ?")
						.all(sessionId),
				).toEqual([{ status: "completed" }]),
			);
			expect(
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND type = 'turn.interrupted'",
					)
					.all(sessionId),
			).toEqual([]);
		} finally {
			db.close();
		}
	}, 60_000);

	it.each([
		{ restart: false, legacy: false },
		{ restart: true, legacy: false },
		{ restart: true, legacy: true },
	])("natural completion releases an unacknowledged Stop and later controls, restart=$restart, legacy=$legacy", async ({
		restart,
		legacy,
	}) => {
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		writeFileSync(
			join(harness.root, "claude", "conduit-test-hold-stop"),
			"hold",
		);
		let browser = await harness.connect();
		const sessionId = await browser.createSession(
			"Natural completion with pending interrupt",
		);
		void browser
			.send(sessionId, "upgrade-long-turn", 60_000)
			.catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "assistant-held"),
				).toBe(true),
			{ timeout: 15_000 },
		);
		const db = new Database(harness.daemonStorePath());
		const commandId = randomUUID();
		const secondCommandId = randomUUID();
		let passed = false;
		try {
			const stop = Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
			).catch(() => undefined);
			await vi.waitFor(() =>
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "stop-held"),
				).toBe(true),
			);
			const secondStop = Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId: secondCommandId }),
			).catch(() => undefined);
			if (restart) {
				await harness.kill();
				await Promise.all([stop, secondStop]);
				if (legacy) {
					db.prepare(
						"UPDATE provider_command_outbox SET payload_json = json_remove(payload_json, '$.stop') WHERE command_id = ?",
					).run(commandId);
					const row = db
						.prepare(
							"SELECT payload_json FROM provider_command_outbox WHERE command_id = ?",
						)
						.get(commandId) as { payload_json: string };
					const payload = Schema.decodeSync(
						Schema.fromJsonString(ProviderControlPayloadSchema),
					)(row.payload_json);
					db.prepare(
						"UPDATE command_receipts SET fingerprint_hash = ? WHERE command_id = ?",
					).run(controlFingerprintHash(payload), commandId);
					db.prepare(
						"UPDATE events SET data = json_remove(data, '$.stop') WHERE type = 'interrupt.requested' AND json_extract(metadata, '$.commandId') = ?",
					).run(commandId);
				}
				await harness.restart();
				browser = await harness.connect(sessionId);
			}
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare("SELECT status FROM provider_runs WHERE session_id = ?")
							.all(sessionId),
					).toEqual([{ status: "completed" }]),
				{ timeout: 10_000 },
			);
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(commandId),
					).toEqual({ status: "completed" }),
				{ timeout: 5000 },
			);
			await Promise.all([stop, secondStop]);
			expect(
				db
					.prepare("SELECT status FROM command_receipts WHERE command_id = ?")
					.get(commandId),
			).toEqual({ status: "side_effect_completed" });
			void browser
				.send(sessionId, "approval-outbox", 20_000)
				.catch(() => undefined);
			const request = await browser.waitFor(
				(frame) => frame["type"] === "permission_pending",
				0,
				15_000,
			);
			await browser.answerApproval(request, "allow");
			await vi.waitFor(() =>
				expect(
					db
						.prepare(
							"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'resolve_permission'",
						)
						.all(sessionId),
				).toEqual([{ status: "completed" }]),
			);
			// A late SDK acknowledgement must not change either terminal or retire the process.
			writeFileSync(join(harness.root, "release-switch-stop"), "release");
			await browser.send(sessionId, "after-obsolete-stop");
			expect(
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND type IN ('turn.interrupted', 'turn.error')",
					)
					.all(sessionId),
			).toEqual([]);
			expect(
				db
					.prepare(
						"SELECT command_id FROM provider_command_outbox WHERE command_id = ?",
					)
					.all(`${commandId}:retire`),
			).toEqual([]);
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "query-closed"),
			).toEqual([]);
			passed = true;
		} finally {
			recoveryEvidence.push({
				scenario: legacy
					? "legacy-unacknowledged-stop-natural-completion-restart"
					: restart
						? "unacknowledged-stop-natural-completion-restart"
						: "unacknowledged-stop-natural-completion",
				passed,
				sessionId,
				commandId,
				secondCommandId,
				commands: db
					.prepare(
						"SELECT command_id, effect_type, provider_process_id, run_id, status, error_code FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
					)
					.all(sessionId),
				runs: db
					.prepare("SELECT id, status FROM provider_runs WHERE session_id = ?")
					.all(sessionId),
				events: db
					.prepare(
						"SELECT type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId),
				nativeCalls: sdkProof(harness),
				restartMarks: harness.proof().generations,
			});
			db.close();
		}
	}, 80_000);

	it("a naturally completed cohort releases runner ownership without an interrupt acknowledgement", async () => {
		const harness = await ProcessHarness.start({
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: 500 },
		});
		harnesses.push(harness);
		writeFileSync(
			join(harness.root, "claude", "conduit-test-hold-stop"),
			"hold",
		);
		const browser = await harness.connect();
		const sessionId = await browser.createSession(
			"Obsolete interrupt runner ownership",
		);
		void browser
			.send(sessionId, "upgrade-long-turn", 60_000)
			.catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "assistant-held"),
				).toBe(true),
			{ timeout: 15_000 },
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started") throw new Error("Missing runner");
		const db = new Database(harness.daemonStorePath());
		const commandId = randomUUID();
		let passed = false;
		try {
			const stop = Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
			);
			await vi.waitFor(() =>
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "stop-held"),
				).toBe(true),
			);
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(commandId),
					).toEqual({ status: "completed" }),
				{ timeout: 5000 },
			);
			await stop;
			await vi.waitFor(
				() => expect(() => process.kill(runner.pid, 0)).toThrow(),
				{ timeout: 5000 },
			);
			expect(
				db
					.prepare("SELECT status FROM provider_runs WHERE session_id = ?")
					.all(sessionId),
			).toEqual([{ status: "completed" }]);
			expect(
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND type IN ('turn.error', 'turn.interrupted')",
					)
					.all(sessionId),
			).toEqual([]);
			passed = true;
		} finally {
			recoveryEvidence.push({
				scenario: "unacknowledged-stop-releases-runner-ownership",
				passed,
				sessionId,
				commandId,
				runner,
				runnerExitMarks: harness.marks.filter(
					(mark) => mark.kind === "runner-idle-exit-started",
				),
				commands: db
					.prepare(
						"SELECT command_id, status FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
					)
					.all(sessionId),
				runs: db
					.prepare("SELECT id, status FROM provider_runs WHERE session_id = ?")
					.all(sessionId),
				nativeCalls: sdkProof(harness),
			});
			db.close();
		}
	}, 45_000);

	it.each([
		false,
		true,
	])("the Stop bound retires an unacknowledged runner control in FIFO order, restart=%s", async (restart) => {
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		writeFileSync(
			join(harness.root, "claude", "conduit-test-hold-stop"),
			"hold",
		);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Silent Stop retirement");
		const send = browser
			.send(sessionId, "upgrade-long-turn", 60_000)
			.catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "assistant-held"),
				).toBe(true),
			{ timeout: 15_000 },
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started") throw new Error("Missing runner");
		const db = new Database(harness.daemonStorePath());
		const commandId = randomUUID();
		let passed = false;
		try {
			db.exec(`CREATE TABLE control_terminals (command_id TEXT, status TEXT);
				CREATE TRIGGER record_control_terminal AFTER UPDATE OF status ON provider_command_outbox
				WHEN NEW.effect_type <> 'send_turn' AND NEW.status IN ('completed', 'failed', 'cancelled')
				BEGIN INSERT INTO control_terminals VALUES (NEW.command_id, NEW.status); END`);
			const stop = Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
			).catch(() => undefined);
			await vi.waitFor(() =>
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "stop-held"),
				).toBe(true),
			);
			const original = db
				.prepare(
					"SELECT payload_json, requested_at FROM provider_command_outbox WHERE command_id = ?",
				)
				.get(commandId) as { payload_json: string; requested_at: number };
			const { stop: snapshot } = JSON.parse(original.payload_json) as {
				stop: ProviderStopSnapshot;
			};
			expect(
				db
					.prepare("SELECT status FROM provider_runs WHERE session_id = ?")
					.all(sessionId),
			).toEqual([{ status: "running" }]);
			if (restart) {
				await harness.kill();
				await stop;
				// Downtime does not spend the control's execution budget. Re-dispatch
				// gets a fresh clock even though the durable Stop deadline has passed.
				await vi.waitFor(
					() => expect(Date.now()).toBeGreaterThan(snapshot.deadlineAt + 6000),
					{
						timeout: 40_000,
						interval: 100,
					},
				);
				await harness.restart();
				await harness.connect(sessionId);
			}
			await vi.waitFor(
				() => expect(() => process.kill(runner.pid, 0)).toThrow(),
				{
					timeout: restart
						? 43_000
						: Math.max(0, snapshot.deadlineAt - Date.now()) + 8000,
					interval: 100,
				},
			);
			await Promise.all([send, stop]);
			await vi.waitFor(() =>
				expect(
					db
						.prepare(
							"SELECT status FROM provider_runs WHERE session_id = ? AND status IN ('pending', 'running')",
						)
						.all(sessionId),
				).toEqual([]),
			);
			expect(
				db
					.prepare(
						"SELECT provider_process_id FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(`${commandId}:retire`),
			).toEqual(
				db
					.prepare(
						"SELECT provider_process_id FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(commandId),
			);
			await vi.waitFor(() =>
				expect(
					db
						.prepare(
							"SELECT command_id, status, error_code FROM provider_command_outbox WHERE command_id IN (?, ?) ORDER BY request_sequence",
						)
						.all(commandId, `${commandId}:retire`),
				).toEqual([
					{
						command_id: commandId,
						status: "failed",
						error_code: "provider_control_timeout",
					},
					{
						command_id: `${commandId}:retire`,
						status: "completed",
						error_code: null,
					},
				]),
			);
			expect(
				db
					.prepare(
						"SELECT command_id, status FROM command_receipts WHERE command_id IN (?, ?) ORDER BY command_id",
					)
					.all(commandId, `${commandId}:retire`),
			).toEqual([
				{ command_id: commandId, status: "side_effect_failed" },
				{ command_id: `${commandId}:retire`, status: "side_effect_completed" },
			]);
			expect(
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.interrupted', 'turn.error')",
					)
					.all(sessionId),
			).toHaveLength(1);
			expect(
				sdkProof(harness).filter(
					(mark) =>
						mark["kind"] === "runner-control" &&
						mark["commandId"] === `${commandId}:retire`,
				),
			).toHaveLength(1);
			expect(
				db
					.prepare(
						"SELECT payload_json, requested_at FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(commandId),
			).toEqual(original);
			expect(
				db
					.prepare(
						"SELECT command_id, COUNT(*) AS count FROM control_terminals GROUP BY command_id ORDER BY command_id",
					)
					.all(),
			).toEqual([
				{ command_id: commandId, count: 1 },
				{ command_id: `${commandId}:retire`, count: 1 },
			]);
			passed = true;
		} finally {
			recoveryEvidence.push({
				scenario: `unacknowledged-stop-fifo-deadline-restart-${restart}`,
				passed,
				sessionId,
				commandId,
				runner,
				terminals: db
					.prepare(
						"SELECT command_id, status FROM control_terminals ORDER BY rowid",
					)
					.all(),
				outcomes: db
					.prepare(
						"SELECT command_id, effect_type, status, error_code, requested_at, updated_at FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
					)
					.all(sessionId),
				receipts: db
					.prepare(
						"SELECT command_id, status, error_code, error FROM command_receipts WHERE session_id = ?",
					)
					.all(sessionId),
				events: db
					.prepare(
						"SELECT type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId),
				process: harness.proof(),
			});
			writeFileSync(
				"/tmp/82tn27-3-round3-stop-deadline.json",
				JSON.stringify({ scenarios: recoveryEvidence }, null, 2),
			);
			db.close();
		}
	}, 110_000);

	it.each([
		{ afterDeadline: false, retirementQueued: false },
		{ afterDeadline: true, retirementQueued: false },
		{ afterDeadline: true, retirementQueued: true },
	])("recovers an acknowledged Stop after daemon restart before its terminal, startup after deadline=$afterDeadline, retirement queued=$retirementQueued", async ({
		afterDeadline,
		retirementQueued,
	}) => {
		const commandId = randomUUID();
		const record: Record<string, unknown> = {
			scenario: retirementQueued
				? "queued-retirement-restarted-past-control-timeout"
				: afterDeadline
					? "acknowledged-stop-startup-after-deadline"
					: "acknowledged-stop-restarted-before-deadline",
			afterDeadline,
			commandId,
			passed: false,
		};
		recoveryEvidence.push(record);
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession(
			"Restarted acknowledged Stop",
		);
		record["sessionId"] = sessionId;
		const send = browser
			.send(sessionId, "upgrade-long-turn", 60_000)
			.catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "assistant-held"),
				).toBe(true),
			{ timeout: 15_000 },
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started") throw new Error("Missing runner");
		const db = new Database(harness.daemonStorePath());
		try {
			if (retirementQueued)
				db.exec(`CREATE TRIGGER hold_retirement BEFORE UPDATE OF status ON provider_command_outbox
					WHEN NEW.command_id = '${commandId}:retire' AND NEW.status = 'running'
					BEGIN SELECT RAISE(IGNORE); END`);
			const stop = Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
			).catch(() => undefined);
			await vi.waitFor(() =>
				expect(
					db
						.prepare(
							"SELECT status FROM provider_command_outbox WHERE command_id = ?",
						)
						.get(commandId),
				).toEqual({ status: "completed" }),
			);
			expect(
				db
					.prepare("SELECT status FROM provider_runs WHERE session_id = ?")
					.all(sessionId),
			).toEqual([{ status: "running" }]);
			const storedPayload = () =>
				JSON.parse(
					(
						db
							.prepare(
								"SELECT payload_json FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(commandId) as { payload_json: string }
					).payload_json,
				) as { stop: ProviderStopSnapshot; providerProcessId: string };
			const original = storedPayload();
			expect(original.stop).toMatchObject({
				owners: [{ runId: expect.any(String) }],
				deadlineAt: expect.any(Number),
				runnerBacked: true,
			});
			const intent = db
				.prepare(
					"SELECT data FROM events WHERE session_id = ? AND type = 'interrupt.requested'",
				)
				.get(sessionId) as { data: string };
			expect(JSON.parse(intent.data)).toMatchObject({ stop: original.stop });
			let resumeAfter = original.stop.deadlineAt;
			if (retirementQueued) {
				await vi.waitFor(
					() =>
						expect(
							db
								.prepare(
									"SELECT status FROM provider_command_outbox WHERE command_id = ?",
								)
								.get(`${commandId}:retire`),
						).toEqual({ status: "pending" }),
					{ timeout: 35_000, interval: 100 },
				);
				const retirement = db
					.prepare(
						"SELECT requested_at FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(`${commandId}:retire`) as { requested_at: number };
				resumeAfter = retirement.requested_at + 36_000;
				record["retirementRequestedAt"] = retirement.requested_at;
				expect(
					sdkProof(harness).filter(
						(mark) => mark["commandId"] === `${commandId}:retire`,
					),
				).toEqual([]);
			}
			await harness.kill();
			record["stoppedAt"] = Date.now();
			await Promise.all([send, stop]);
			if (afterDeadline)
				await vi.waitFor(
					() => expect(Date.now()).toBeGreaterThan(resumeAfter),
					{ timeout: 40_000, interval: 100 },
				);
			if (retirementQueued) db.exec("DROP TRIGGER hold_retirement");
			record["restartedAt"] = Date.now();
			await harness.restart();
			// An already-committed retirement must recover without a client
			// reissuing Stop. The other cases separately exercise that replay.
			const restartedBrowser = retirementQueued
				? undefined
				: await harness.connect(sessionId);
			const duplicateStop = restartedBrowser
				? Effect.runPromise(
						restartedBrowser.rpc.CancelSession({ sessionId, commandId }),
					).catch(() => undefined)
				: Promise.resolve();
			if (!afterDeadline) {
				await harness.kill();
				await duplicateStop;
				await harness.restart();
				await harness.connect(sessionId);
			}
			expect(storedPayload()).toEqual(original);
			await vi.waitFor(
				() => expect(() => process.kill(runner.pid, 0)).toThrow(),
				{
					timeout: afterDeadline
						? 12_000
						: Math.max(0, original.stop.deadlineAt - Date.now()) + 12_000,
					interval: 100,
				},
			);
			await duplicateStop;
			await vi.waitFor(() =>
				expect(
					db
						.prepare(
							"SELECT status FROM provider_runs WHERE session_id = ? AND status IN ('pending', 'running')",
						)
						.all(sessionId),
				).toEqual([]),
			);
			expect(
				db
					.prepare(
						"SELECT command_id FROM provider_command_outbox WHERE command_id = ?",
					)
					.all(`${commandId}:retire`),
			).toEqual([{ command_id: `${commandId}:retire` }]);
			// Process exit can precede the receipt commit. Observe that commit
			// before the second restart, which checks completed-command replay.
			await vi.waitFor(() =>
				expect(
					db
						.prepare(
							"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ?",
						)
						.get(`${commandId}:retire`),
				).toEqual({ status: "completed", error_code: null }),
			);
			await harness.kill();
			await harness.restart();
			if (!retirementQueued) await harness.connect(sessionId);
			expect(
				db
					.prepare(
						"SELECT command_id FROM provider_command_outbox WHERE command_id = ?",
					)
					.all(`${commandId}:retire`),
			).toHaveLength(1);
			expect(
				sdkProof(harness).filter(
					(mark) =>
						mark["kind"] === "runner-control" &&
						mark["commandId"] === `${commandId}:retire`,
				),
			).toHaveLength(1);
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "query-closed"),
			).toHaveLength(1);
			expect(
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.interrupted', 'turn.error')",
					)
					.all(sessionId),
			).toHaveLength(1);
			expect(
				db
					.prepare(
						"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(`${commandId}:retire`),
			).toEqual({ status: "completed", error_code: null });
			record["passed"] = true;
		} finally {
			Object.assign(record, {
				commands: db
					.prepare(
						"SELECT command_id, effect_type, payload_json, provider_process_id, status, error_code, requested_at, updated_at FROM provider_command_outbox WHERE session_id = ? AND effect_type <> 'send_turn' ORDER BY request_sequence",
					)
					.all(sessionId),
				runs: db
					.prepare("SELECT id, status FROM provider_runs WHERE session_id = ?")
					.all(sessionId),
				events: db
					.prepare(
						"SELECT type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId),
				nativeCalls: sdkProof(harness).filter((mark) =>
					["query-interrupted", "query-closed", "runner-control"].includes(
						String(mark["kind"]),
					),
				),
				restartMarks: harness.proof().generations,
			});
			writeFileSync(
				"/tmp/82tn27-3-repair-f1-proof.json",
				JSON.stringify({ scenarios: recoveryEvidence }, null, 2),
			);
			if (retirementQueued)
				writeFileSync(
					"/tmp/82tn27-3-round4-retirement-restart.json",
					JSON.stringify(record, null, 2),
				);
			db.close();
		}
	}, 135_000);
});
