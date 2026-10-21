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

afterAll(() => writeProviderCommandOutboxProof(recoveryEvidence));

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

	it("the Stop bound retires a runner even when the SDK never acknowledges interrupt", async () => {
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
		try {
			const commandId = randomUUID();
			const stop = Effect.runPromise(
				browser.rpc.CancelSession({ sessionId, commandId }),
			).catch(() => undefined);
			await vi.waitFor(() =>
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "stop-held"),
				).toBe(true),
			);
			expect(
				db
					.prepare("SELECT status FROM provider_runs WHERE session_id = ?")
					.all(sessionId),
			).toEqual([{ status: "running" }]);
			await vi.waitFor(
				() => expect(() => process.kill(runner.pid, 0)).toThrow(),
				{ timeout: 40_000, interval: 100 },
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
			writeFileSync(
				"/tmp/82tn27-stop-retirement.json",
				JSON.stringify(
					{
						sessionId,
						commandId,
						runner,
						outcomes: db
							.prepare(
								"SELECT command_id, effect_type, provider_process_id, status, error_code FROM provider_command_outbox WHERE session_id = ?",
							)
							.all(sessionId),
						events: db
							.prepare(
								"SELECT type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
							)
							.all(sessionId),
						process: harness.proof(),
					},
					null,
					2,
				),
			);
		} finally {
			db.close();
		}
	}, 75_000);

	it.each([
		false,
		true,
	])("recovers an acknowledged Stop after daemon restart before its terminal, startup after deadline=%s", async (afterDeadline) => {
		const commandId = randomUUID();
		const record: Record<string, unknown> = {
			scenario: afterDeadline
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
			await harness.kill();
			await Promise.all([send, stop]);
			if (afterDeadline)
				await vi.waitFor(
					() => expect(Date.now()).toBeGreaterThan(original.stop.deadlineAt),
					{ timeout: 35_000, interval: 100 },
				);
			await harness.restart();
			const restartedBrowser = await harness.connect(sessionId);
			const duplicateStop = Effect.runPromise(
				restartedBrowser.rpc.CancelSession({ sessionId, commandId }),
			).catch(() => undefined);
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
			await harness.kill();
			await harness.restart();
			await harness.connect(sessionId);
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
			record["passed"] = true;
		} finally {
			Object.assign(record, {
				commands: db
					.prepare(
						"SELECT command_id, effect_type, payload_json, provider_process_id, status, error_code FROM provider_command_outbox WHERE session_id = ? AND effect_type <> 'send_turn' ORDER BY request_sequence",
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
			db.close();
		}
	}, 100_000);
});
