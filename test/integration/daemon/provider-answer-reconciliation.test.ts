import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerSocket } from "../../../src/lib/provider/runner/runner-protocol.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

function sdkProof(harness: ProcessHarness) {
	return readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runner answer timeout reconciliation", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.dispose();
			harness.assertNoRunners();
		}
	});

	it("reads original command receipt states from a detached runner", async () => {
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession(
			"Runner command receipt states",
		);
		void browser
			.send(sessionId, "task-stop-foreground-correction-reject", 60_000)
			.catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some(
						(mark) =>
							mark["kind"] === "task-stop-turn" &&
							mark["phase"] === "streaming",
					),
				).toBe(true),
			{ timeout: 15_000 },
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started") throw new Error("Missing runner");
		await harness.kill();
		let direct: RunnerSocket | undefined;
		const statuses: Record<string, string> = {};
		let passed = false;
		try {
			direct = await Effect.runPromise(
				Effect.tryPromise(
					() =>
						new Promise<RunnerSocket>((resolve, reject) => {
							const socket = createConnection(runner.socketPath);
							const peer = new RunnerSocket(
								socket,
								(message) => {
									if (message.type === "hello") resolve(peer);
								},
								(failure) => reject(new Error(failure.message)),
							);
							direct = peer;
							socket.once("connect", () =>
								peer.write({
									type: "hello",
									protocolVersion: runner.protocolVersion,
									buildId: runner.buildId,
									config: {
										workspaceRoot: harness.projectDir,
										daemonConfigDir: harness.configDir,
									},
								}),
							);
						}),
				).pipe(Effect.timeout("15 seconds")),
			);
			statuses["unknown"] = await Effect.runPromise(
				direct.commandStatusEffect(randomUUID()),
			);
			expect(statuses["unknown"]).toBe("not_received");
			const failedId = randomUUID();
			const failure = await Effect.runPromise(
				Effect.result(
					direct.commandEffect(failedId, { type: "interrupt", sessionId }),
				),
			);
			expect(failure._tag).toBe("Failure");
			statuses["failed"] = await Effect.runPromise(
				direct.commandStatusEffect(failedId),
			);
			expect(statuses["failed"]).toBe("failed");
			writeFileSync(
				join(harness.root, "task-stop-correction-allow-interrupt"),
				"allow",
			);
			writeFileSync(
				join(harness.root, "claude", "conduit-test-hold-stop"),
				"hold",
			);
			const runningId = randomUUID();
			const interrupt = Effect.runPromise(
				direct.commandEffect(runningId, { type: "interrupt", sessionId }),
			);
			await vi.waitFor(() =>
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "stop-held"),
				).toBe(true),
			);
			statuses["running"] = await Effect.runPromise(
				direct.commandStatusEffect(runningId),
			);
			expect(statuses["running"]).toBe("running");
			writeFileSync(join(harness.root, "release-switch-stop"), "release");
			await interrupt;
			statuses["completed"] = await Effect.runPromise(
				direct.commandStatusEffect(runningId),
			);
			expect(statuses["completed"]).toBe("completed");
			passed = true;
		} finally {
			direct?.destroy();
			writeFileSync(
				"/tmp/82tn27-3-answer-command-states.json",
				JSON.stringify({ passed, sessionId, runner, statuses }, null, 2),
			);
		}
	}, 60_000);

	it.each([
		false,
		true,
	])("keeps a consumed answer resolved after timeout, replace runner during reconciliation=%s", async (replaceRunner) => {
		const harness = await ProcessHarness.start({ restartProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Consumed answer timeout");
		const send = browser
			.send(sessionId, "approval-outbox", 60_000)
			.catch(() => undefined);
		const request = await browser.waitFor(
			(frame) => frame["type"] === "permission_pending",
			0,
			15_000,
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started") throw new Error("Missing runner");
		const gate = join(
			dirname(runner.socketPath),
			"conduit-test-hold-answer-reply",
		);
		writeFileSync(gate, "hold");
		const statusGate = join(
			dirname(runner.socketPath),
			"conduit-test-hold-command-status-reply",
		);
		if (replaceRunner) writeFileSync(statusGate, "hold");
		const db = new Database(harness.daemonStorePath());
		const commandId = randomUUID();
		const originalRun = db
			.prepare(
				"SELECT id FROM provider_runs WHERE session_id = ? ORDER BY requested_at LIMIT 1",
			)
			.get(sessionId) as { id: string };
		let passed = false;
		const snapshot = () => ({
			prompts: db
				.prepare("SELECT status FROM pending_approvals WHERE session_id = ?")
				.all(sessionId),
			controls: db
				.prepare(
					"SELECT command_id, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'resolve_permission'",
				)
				.all(sessionId),
			promptProvenance: db
				.prepare(
					"SELECT id, status, version, provider_process_id FROM pending_approvals WHERE session_id = ?",
				)
				.all(sessionId),
			terminals: db
				.prepare(
					"SELECT type, json_extract(metadata, '$.runId') AS run_id FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.error', 'turn.interrupted')",
				)
				.all(sessionId),
		});
		try {
			const answer = Effect.runPromise(
				browser.rpc.RespondPermission({
					projectSlug: "process-test",
					originId: browser.originId,
					commandId,
					requestId: String(request["requestId"]),
					decision: "allow",
				}),
			).catch(() => undefined);
			await vi.waitFor(
				() =>
					expect(
						sdkProof(harness).filter((mark) => mark["kind"] === "approval"),
					).toHaveLength(1),
				{ timeout: 10_000 },
			);
			if (replaceRunner) {
				await vi.waitFor(
					() =>
						expect(
							sdkProof(harness).some(
								(mark) =>
									mark["kind"] === "runner-command-status-held" &&
									mark["commandId"] === commandId,
							),
						).toBe(true),
					{ timeout: 40_000 },
				);
				process.kill(runner.pid, "SIGKILL");
				await vi.waitFor(() =>
					expect(() => process.kill(runner.pid, 0)).toThrow(),
				);
			}
			await vi.waitFor(
				() =>
					expect(snapshot().controls).toEqual([
						{
							command_id: commandId,
							status: replaceRunner
								? expect.stringMatching(/^(failed|cancelled)$/)
								: "failed",
						},
					]),
				{ timeout: 40_000 },
			);
			rmSync(gate);
			await answer;
			await send;
			if (replaceRunner) {
				await browser.send(
					sessionId,
					"after-answer-reconciliation-runner-restart",
				);
				const replacements = harness.marks.filter(
					(mark) => mark.kind === "runner-started",
				);
				expect(replacements).toHaveLength(2);
			} else {
				expect(snapshot().prompts).toEqual([{ status: "resolved" }]);
				await vi.waitFor(() =>
					expect(
						sdkProof(harness).some(
							(mark) =>
								mark["kind"] === "runner-answer-reply-released" &&
								mark["commandId"] === commandId,
						),
					).toBe(true),
				);
			}
			expect(snapshot().prompts).toEqual([{ status: "resolved" }]);
			expect(
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND json_extract(metadata, '$.runId') = ? AND type IN ('turn.completed', 'turn.error', 'turn.interrupted')",
					)
					.all(sessionId, originalRun.id),
			).toEqual([{ type: "turn.completed" }]);
			await browser.answerApproval(request, "allow");
			expect(snapshot().controls).toHaveLength(1);
			expect(
				sdkProof(harness).filter(
					(mark) =>
						mark["kind"] === "runner-control" &&
						mark["type"] === "resolve-permission",
				),
			).toHaveLength(1);
			passed = true;
		} finally {
			writeFileSync(
				replaceRunner
					? "/tmp/82tn27-3-answer-reconciliation-restart.json"
					: "/tmp/82tn27-3-answer-reconciliation.json",
				JSON.stringify(
					{
						scenario: replaceRunner
							? "consumed-answer-runner-restart-during-reconciliation"
							: "consumed-answer-late-reply",
						passed,
						sessionId,
						runner,
						originalRun,
						runners: harness.marks.filter(
							(mark) => mark.kind === "runner-started",
						),
						...snapshot(),
						sdkProof: sdkProof(harness),
					},
					null,
					2,
				),
			);
			rmSync(gate, { force: true });
			rmSync(statusGate, { force: true });
			db.close();
		}
	}, 90_000);
});
