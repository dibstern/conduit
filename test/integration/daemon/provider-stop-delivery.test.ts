import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { writeProviderCommandOutboxProof } from "../../helpers/provider-command-outbox-proof.js";

function sdkProof(harness: ProcessHarness) {
	return readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Stop delivery preserves its captured cohort", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.dispose();
			harness.assertNoRunners();
		}
	});

	it("a delayed empty Stop preserves a newer foreground turn across restart", async () => {
		writeProviderCommandOutboxProof([
			{ scenario: "delayed-empty-stop-newer-turn", passed: false },
		]);
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Empty Stop delivery");
		await browser.send(sessionId, "seed-completed-owner");
		const db = new Database(harness.daemonStorePath());
		const commandId = randomUUID();
		let passed = false;
		try {
			db.exec(`CREATE TRIGGER hold_empty_stop BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.command_id = '${commandId}' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
			);
			expect(
				db
					.prepare(
						"SELECT status, json_extract(payload_json, '$.turnIds') AS turn_ids FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(commandId),
			).toEqual({ status: "pending", turn_ids: "[]" });
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
			db.exec("DROP TRIGGER hold_empty_stop");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(commandId),
					).toEqual({ status: "completed" }),
				{ timeout: 10_000 },
			);
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "query-closed"),
			).toEqual([]);
			await harness.kill();
			await send;
			await harness.restart();
			await harness.connect(sessionId);
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "query-closed"),
			).toEqual([]);
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
							)
							.all(sessionId),
					).toEqual([{ status: "completed" }, { status: "completed" }]),
				{ timeout: 15_000 },
			);
			passed = true;
		} finally {
			writeFileSync(
				"/tmp/82tn27-3-repair-f2-proof.json",
				JSON.stringify(
					{
						scenario: "delayed-empty-stop-newer-turn",
						passed,
						sessionId,
						commandId,
						commands: db
							.prepare(
								"SELECT command_id, effect_type, provider_process_id, run_id, status, error_code FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
							)
							.all(sessionId),
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
						nativeCalls: sdkProof(harness).filter((mark) =>
							["query-interrupted", "query-closed", "runner-control"].includes(
								String(mark["kind"]),
							),
						),
						restartMarks: harness.proof().generations,
					},
					null,
					2,
				),
			);
			writeProviderCommandOutboxProof([
				JSON.parse(
					readFileSync("/tmp/82tn27-3-repair-f2-proof.json", "utf8"),
				) as Record<string, unknown>,
			]);
			db.close();
		}
	}, 100_000);

	it("a delayed empty Stop preserves a pending steer after foreground completion", async () => {
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession(
			"Empty Stop with pending steer",
		);
		await browser.send(sessionId, "seed-completed-owner");
		const db = new Database(harness.daemonStorePath());
		const commandId = randomUUID();
		const steerId = randomUUID();
		let passed = false;
		try {
			db.exec(`CREATE TRIGGER hold_empty_stop BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.command_id = '${commandId}' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
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
			expect(
				await Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId: steerId,
						delivery: "steer",
						text: "load-stream-stop-before-intake",
					}),
				),
			).toMatchObject({ ok: true, handedOff: true });
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			await vi.waitFor(
				() =>
					expect(
						sdkProof(harness).some((mark) => mark["kind"] === "intake-held"),
					).toBe(true),
				{ timeout: 10_000 },
			);
			db.exec("DROP TRIGGER hold_empty_stop");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(commandId),
					).toEqual({ status: "completed" }),
				{ timeout: 10_000 },
			);
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "query-closed"),
			).toEqual([]);
			expect(
				db
					.prepare(
						"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
					)
					.all(sessionId),
			).toEqual([
				{ status: "completed" },
				{ status: "completed" },
				{ status: "pending" },
			]);
			writeFileSync(join(harness.root, "release-stop-intake"), "release");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT started_at FROM provider_runs WHERE session_id = ? AND id = (SELECT run_id FROM provider_command_outbox WHERE command_id = ?)",
							)
							.get(sessionId, steerId),
					).toMatchObject({ started_at: expect.any(Number) }),
				{ timeout: 10_000 },
			);
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "query-closed"),
			).toEqual([]);
			passed = true;
		} finally {
			writeProviderCommandOutboxProof([
				{
					scenario: "delayed-empty-stop-pending-steer",
					passed,
					sessionId,
					commandId,
					steerId,
					commands: db
						.prepare(
							"SELECT command_id, effect_type, provider_process_id, run_id, status FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
						)
						.all(sessionId),
					runs: db
						.prepare(
							"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
						)
						.all(sessionId),
					nativeCalls: sdkProof(harness),
					restartMarks: harness.proof().generations,
				},
			]);
			db.close();
		}
	}, 90_000);

	it("a delayed empty OpenCode Stop does not abort its successor", async () => {
		const harness = await ProcessHarness.start({ managedOpenCode: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession(
			"Empty OpenCode Stop",
			"managed-test",
			"opencode",
		);
		await browser.send(sessionId, "seed-completed-owner");
		const db = new Database(harness.daemonStorePath());
		const commandId = randomUUID();
		const successorId = randomUUID();
		let passed = false;
		try {
			db.exec(`CREATE TRIGGER hold_empty_stop BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.command_id = '${commandId}' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			await Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
			);
			expect(
				db
					.prepare(
						"SELECT status, json_extract(payload_json, '$.stop.owners') AS owners FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(commandId),
			).toEqual({ status: "pending", owners: "[]" });
			writeFileSync(join(harness.configDir, "fake-opencode-hold-turn"), "hold");
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId: successorId,
					delivery: "queue",
					text: "successor",
				}),
			);
			await vi.waitFor(
				() =>
					expect(
						harness
							.opencodeRequests()
							.filter(
								({ method, url }) =>
									method === "POST" &&
									url.split("?")[0] === `/session/${sessionId}/prompt_async`,
							),
					).toHaveLength(2),
				{ timeout: 15_000 },
			);
			expect(
				db
					.prepare(
						"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
					)
					.all(sessionId),
			).toEqual([{ status: "completed" }, { status: "pending" }]);
			db.exec("DROP TRIGGER hold_empty_stop");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(commandId),
					).toMatchObject({
						status: expect.stringMatching(/^(completed|failed)$/),
					}),
				{ timeout: 10_000 },
			);
			expect(
				harness
					.opencodeRequests()
					.filter(
						({ url }) => url.split("?")[0] === `/session/${sessionId}/abort`,
					),
			).toEqual([]);
			expect(
				db
					.prepare(
						"SELECT status FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(commandId),
			).toEqual({ status: "completed" });
			expect(
				db
					.prepare(
						"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
					)
					.all(sessionId),
			).toEqual([{ status: "completed" }, { status: "pending" }]);
			passed = true;
		} finally {
			writeProviderCommandOutboxProof([
				{
					scenario: "delayed-empty-stop-opencode-successor",
					passed,
					sessionId,
					commandId,
					successorId,
					commands: db
						.prepare(
							"SELECT command_id, effect_type, provider_process_id, run_id, status FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
						)
						.all(sessionId),
					runs: db
						.prepare(
							"SELECT id, status FROM provider_runs WHERE session_id = ?",
						)
						.all(sessionId),
					nativeCalls: harness.opencodeRequests(),
					restartMarks: harness.proof().generations,
				},
			]);
			db.close();
		}
	}, 90_000);

	it.each([
		false,
		true,
	])("a delayed retirement preserves its successor, projection delayed=%s", async (projectionDelayed) => {
		const scenario = projectionDelayed
			? "delayed-retirement-native-cohort-check"
			: "delayed-retirement-retained-successor";
		const proofPath = projectionDelayed
			? "/tmp/82tn27-3-repair-f3-native-proof.json"
			: "/tmp/82tn27-3-repair-f3-proof.json";
		writeProviderCommandOutboxProof([{ scenario, passed: false }]);
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Retirement cohort");
		const send = browser
			.send(sessionId, "upgrade-long-turn", 90_000)
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
		const successorId = randomUUID();
		const original = db
			.prepare("SELECT id FROM provider_runs WHERE session_id = ?")
			.get(sessionId) as { id: string };
		const runnerSnapshots: Record<string, unknown>[] = [];
		const captureRunner = (stage: string) => {
			let alive = true;
			try {
				process.kill(runner.pid, 0);
			} catch {
				alive = false;
			}
			const registration = `${runner.socketPath}.json`;
			runnerSnapshots.push({
				stage,
				alive,
				registration: existsSync(registration)
					? readFileSync(registration, "utf8")
					: null,
			});
		};
		captureRunner("original");
		let passed = false;
		try {
			if (projectionDelayed)
				db.exec(`CREATE TRIGGER delay_terminal_projection BEFORE UPDATE OF status ON provider_runs
					WHEN NEW.id = '${original.id}' AND NEW.status = 'completed'
					BEGIN SELECT RAISE(IGNORE); END`);
			expect(
				await Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId: successorId,
						delivery: "steer",
						text: "load-stream-successor",
					}),
				),
			).toMatchObject({ ok: true, handedOff: true });
			db.exec(`CREATE TRIGGER hold_retirement BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.command_id = '${commandId}:retire' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			const stop = Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
			).catch(() => undefined);
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(`${commandId}:retire`),
					).toEqual({ status: "pending" }),
				{ timeout: 40_000, interval: 100 },
			);
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
							)
							.all(sessionId),
					).toEqual([
						{ status: projectionDelayed ? "running" : "completed" },
						{ status: "running" },
					]),
				{ timeout: 10_000 },
			);
			let recovered = browser;
			if (!projectionDelayed) {
				await harness.kill();
				await Promise.all([send, stop]);
				captureRunner("before-restart");
				await harness.restart();
				captureRunner("after-restart");
				recovered = await harness.connect(sessionId);
			}
			db.exec("DROP TRIGGER hold_retirement");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(`${commandId}:retire`),
					).toEqual({ status: "completed" }),
				{ timeout: 10_000 },
			);
			expect(() => process.kill(runner.pid, 0)).not.toThrow();
			expect(
				sdkProof(harness).filter(
					(mark) =>
						mark["kind"] === "runner-control" &&
						mark["commandId"] === `${commandId}:retire`,
				),
			).toHaveLength(projectionDelayed ? 1 : 0);
			expect(
				db
					.prepare(
						"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
					)
					.all(sessionId),
			).toEqual([
				{ status: projectionDelayed ? "running" : "completed" },
				{ status: "running" },
			]);
			if (projectionDelayed) {
				db.exec("DROP TRIGGER delay_terminal_projection");
				db.prepare(
					"UPDATE provider_runs SET status = 'completed' WHERE id = ?",
				).run(original.id);
			}
			// Ordinary End must still stop the successor and permit a fresh runner.
			await recovered.reloadSession(sessionId);
			await vi.waitFor(() =>
				expect(() => process.kill(runner.pid, 0)).toThrow(),
			);
			await recovered.send(sessionId, "after-stale-retirement");
			passed = true;
		} finally {
			captureRunner("finally");
			const runnersLog = join(harness.configDir, "runners.log");
			writeFileSync(
				proofPath,
				JSON.stringify(
					{
						scenario,
						projectionDelayed,
						passed,
						processProof: harness.proof(),
						sdkMarks: sdkProof(harness),
						runnerSnapshots,
						runnersLog: existsSync(runnersLog)
							? readFileSync(runnersLog, "utf8").slice(-12_000)
							: null,
						sessionId,
						commandId,
						successorId,
						runner,
						commands: db
							.prepare(
								"SELECT command_id, effect_type, payload_json, provider_process_id, run_id, status, error_code FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
							)
							.all(sessionId),
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
						nativeCalls: sdkProof(harness).filter((mark) =>
							["query-interrupted", "query-closed", "runner-control"].includes(
								String(mark["kind"]),
							),
						),
						restartMarks: harness.proof().generations,
					},
					null,
					2,
				),
			);
			writeProviderCommandOutboxProof([
				JSON.parse(readFileSync(proofPath, "utf8")) as Record<string, unknown>,
			]);
			db.close();
		}
	}, 110_000);

	it("a delayed retirement preserves a successor before SDK intake", async () => {
		const scenario = "delayed-retirement-pending-intake";
		const proofPath = "/tmp/82tn27-3-repair-f3-intake-proof.json";
		writeProviderCommandOutboxProof([{ scenario, passed: false }]);
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Retirement pending intake");
		void browser
			.send(sessionId, "upgrade-long-turn", 90_000)
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
		const successorId = randomUUID();
		const original = db
			.prepare("SELECT id FROM provider_runs WHERE session_id = ?")
			.get(sessionId) as { id: string };
		let passed = false;
		let retirementClosedQueries: number | undefined;
		try {
			db.exec(`CREATE TRIGGER delay_terminal_projection BEFORE UPDATE OF status ON provider_runs
				WHEN NEW.id = '${original.id}' AND NEW.status = 'completed'
				BEGIN SELECT RAISE(IGNORE); END`);
			db.exec(`CREATE TRIGGER hold_retirement BEFORE UPDATE OF status ON provider_command_outbox
				WHEN NEW.command_id = '${commandId}:retire' AND NEW.status = 'running'
				BEGIN SELECT RAISE(IGNORE); END`);
			expect(
				await Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId: successorId,
						delivery: "steer",
						text: "load-stream-stop-before-intake",
					}),
				),
			).toMatchObject({ ok: true, handedOff: true });
			const stop = Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
			).catch(() => undefined);
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(`${commandId}:retire`),
					).toEqual({ status: "pending" }),
				{ timeout: 40_000, interval: 100 },
			);
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT type FROM events WHERE session_id = ? AND type = 'turn.completed'",
							)
							.get(sessionId),
					).toEqual({ type: "turn.completed" }),
				{ timeout: 10_000 },
			);
			await vi.waitFor(
				() =>
					expect(
						sdkProof(harness).some((mark) => mark["kind"] === "intake-held"),
					).toBe(true),
				{ timeout: 10_000 },
			);
			db.exec("DROP TRIGGER hold_retirement");
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE command_id = ?",
							)
							.get(`${commandId}:retire`),
					).toEqual({ status: "completed" }),
				{ timeout: 10_000 },
			);
			expect(() => process.kill(runner.pid, 0)).not.toThrow();
			expect(
				sdkProof(harness).filter(
					(mark) =>
						mark["kind"] === "runner-control" &&
						mark["commandId"] === `${commandId}:retire`,
				),
			).toHaveLength(1);
			retirementClosedQueries = sdkProof(harness).filter(
				(mark) => mark["kind"] === "query-closed",
			).length;
			expect(retirementClosedQueries).toBe(0);
			writeFileSync(join(harness.root, "release-stop-intake"), "release");
			await vi.waitFor(() =>
				expect(
					db
						.prepare(
							"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
						)
						.all(sessionId),
				).toEqual([{ status: "running" }, { status: "running" }]),
			);
			db.exec("DROP TRIGGER delay_terminal_projection");
			db.prepare(
				"UPDATE provider_runs SET status = 'completed' WHERE id = ?",
			).run(original.id);
			await browser.reloadSession(sessionId);
			await vi.waitFor(() =>
				expect(() => process.kill(runner.pid, 0)).toThrow(),
			);
			await stop;
			await browser.send(sessionId, "after-pending-intake-retirement");
			passed = true;
		} finally {
			const proof = {
				scenario,
				passed,
				retirementClosedQueries,
				sessionId,
				commandId,
				successorId,
				runner,
				commands: db
					.prepare(
						"SELECT command_id, effect_type, payload_json, status, error_code FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
					)
					.all(sessionId),
				runs: db
					.prepare("SELECT id, status FROM provider_runs WHERE session_id = ?")
					.all(sessionId),
				nativeCalls: sdkProof(harness).filter((mark) =>
					["intake-held", "query-closed", "runner-control"].includes(
						String(mark["kind"]),
					),
				),
			};
			writeFileSync(proofPath, JSON.stringify(proof, null, 2));
			writeProviderCommandOutboxProof([proof]);
			db.close();
		}
	}, 110_000);

	it("bounds replacement of a live question when interrupt never acknowledges", async () => {
		writeProviderCommandOutboxProof([
			{ scenario: "question-replacement-unacknowledged-stop", passed: false },
		]);
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		writeFileSync(
			join(harness.root, "claude", "conduit-test-hold-stop"),
			"hold",
		);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Question replacement Stop");
		const send = browser
			.send(sessionId, "question-fixed-replacement", 70_000)
			.catch(() => undefined);
		await browser.waitFor(
			(frame) => frame["type"] === "question_pending",
			0,
			20_000,
		);
		const db = new Database(harness.daemonStorePath());
		const inputId = randomUUID();
		let replySettled = false;
		let replyError: string | undefined;
		let passed = false;
		try {
			const reply = Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId,
					delivery: "queue",
					text: "replacement-after-question",
				}),
			).then(
				() => {
					replySettled = true;
				},
				(error: unknown) => {
					replyError = String(error);
					replySettled = true;
				},
			);
			await vi.waitFor(() =>
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "stop-held"),
				).toBe(true),
			);
			await vi.waitFor(() => expect(replySettled).toBe(true), {
				timeout: 37_000,
				interval: 100,
			});
			await reply;
			expect(replyError).toBeUndefined();
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare(
								"SELECT run.status FROM provider_runs run JOIN provider_command_outbox command ON command.run_id = run.id WHERE command.command_id = ?",
							)
							.get(inputId),
					).toEqual({ status: "completed" }),
				{ timeout: 15_000 },
			);
			expect(
				db
					.prepare(
						"SELECT command_id, status FROM provider_command_outbox WHERE command_id = ?",
					)
					.get(`${inputId}:interrupt-for-question:retire`),
			).toEqual({
				command_id: `${inputId}:interrupt-for-question:retire`,
				status: "completed",
			});
			await send;
			passed = true;
		} finally {
			writeFileSync(
				"/tmp/82tn27-3-repair-f4-proof.json",
				JSON.stringify(
					{
						scenario: "question-replacement-unacknowledged-stop",
						passed,
						sessionId,
						inputId,
						replySettled,
						replyError,
						commands: db
							.prepare(
								"SELECT command_id, effect_type, provider_process_id, run_id, status, error_code FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
							)
							.all(sessionId),
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
						nativeCalls: sdkProof(harness).filter((mark) =>
							["query-interrupted", "query-closed", "runner-control"].includes(
								String(mark["kind"]),
							),
						),
						restartMarks: harness.proof().generations,
					},
					null,
					2,
				),
			);
			writeProviderCommandOutboxProof([
				JSON.parse(
					readFileSync("/tmp/82tn27-3-repair-f4-proof.json", "utf8"),
				) as Record<string, unknown>,
			]);
			db.close();
		}
	}, 90_000);

	it("question replacement with acknowledgement completes without retirement", async () => {
		const record: Record<string, unknown> = {
			scenario: "question-replacement-acknowledged-stop",
			passed: false,
		};
		writeProviderCommandOutboxProof([record]);
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession(
			"Acknowledged question replacement",
		);
		const send = browser
			.send(sessionId, "question-fixed-replacement")
			.catch(() => undefined);
		await browser.waitFor(
			(frame) => frame["type"] === "question_pending",
			0,
			20_000,
		);
		const db = new Database(harness.daemonStorePath());
		try {
			await browser.send(sessionId, "acknowledged-question-replacement");
			await send;
			expect(
				db
					.prepare(
						"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'interrupt_turn'",
					)
					.all(sessionId),
			).toEqual([{ status: "completed" }]);
			expect(
				db
					.prepare(
						"SELECT command_id FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'end_session'",
					)
					.all(sessionId),
			).toEqual([]);
			await browser.send(sessionId, "ordinary-input-after-replacement");
			expect(
				db
					.prepare(
						"SELECT command_id FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'interrupt_turn'",
					)
					.all(sessionId),
			).toHaveLength(1);
			record["passed"] = true;
		} finally {
			Object.assign(record, {
				sessionId,
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
				nativeCalls: sdkProof(harness).filter((mark) =>
					["query-interrupted", "query-closed", "runner-control"].includes(
						String(mark["kind"]),
					),
				),
				restartMarks: harness.proof().generations,
			});
			writeProviderCommandOutboxProof([record]);
			db.close();
		}
	}, 60_000);
});
