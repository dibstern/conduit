// Failures: ordinary runner startup is refused, or the original send needs a
// resend or enters twice.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

it("waits through runner startup beyond the busy admission grace without refusing", async () => {
	const harness = ProcessHarness.create({
		dist: "dist",
		restartProof: true,
		logLevel: "warn",
		runnerLifecycle: { helloDelayMs: 2_500 },
	});
	const observations: Record<string, unknown> = {};
	let db: Database.Database | undefined;
	let warming: Promise<void> | undefined;
	try {
		await harness.restart();
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Readiness admission proof");
		db = new Database(harness.daemonStorePath(), { readonly: true });
		warming = browser.preWarmSession(sessionId);
		void warming.catch(() => undefined);
		await harness.waitForMark((mark) => mark.kind === "runner-hello-pending");
		const inputId = randomUUID();
		const text = "m1it original send waits for readiness";
		observations["sessionId"] = sessionId;
		observations["inputId"] = inputId;
		const sentAt = Date.now();
		const cursor = browser.frames.length;
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					inputId,
					text,
					originId: browser.originId,
					delivery: "queue",
				}),
			),
		).toMatchObject({ ok: true });
		await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
		observations["startupWaitAfterMs"] = Date.now() - sentAt;
		const command = db
			.prepare<[string], Record<string, unknown>>(
				"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ?",
			)
			.get(inputId);
		observations["commandDuringStartup"] = command;
		expect(command).toMatchObject({
			status: "running",
			error_code: null,
		});
		const before = harness.runnerPids();
		await warming;
		await browser.waitForTurnEnd(sessionId, cursor, 10_000, inputId);
		const history = await browser.history(sessionId);
		expect(
			history.filter(
				(message) => message.role === "user" && message.inputId === inputId,
			),
		).toHaveLength(1);
		const reply = history
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.parts ?? [])
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("");
		expect(reply).toBe(responseChunks(text).join(""));
		expect(harness.runnerPids()).toEqual(before);
		const logs = harness.logTail
			.split("\n")
			.filter(
				(line) =>
					line.includes("send_admission_timeout") &&
					line.includes(`inputId=${inputId}`),
			);
		expect(logs).toEqual([]);
		observations["admissionLogs"] = logs;
		const completed = db.prepare<
			[string],
			{ status: string; error_code: string | null }
		>(
			"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ?",
		);
		await vi.waitFor(() =>
			expect(completed.get(inputId)).toEqual({
				status: "completed",
				error_code: null,
			}),
		);
		observations["completed"] = completed.get(inputId);
		const marks = readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ProcessMark);
		expect(
			marks.filter((mark) => mark.kind === "enqueue" && mark.request === text),
		).toHaveLength(1);
		observations["sdkMarks"] = marks;
		observations["runnerPids"] = before;
		observations["reply"] = reply;
	} finally {
		db?.close();
		observations["logTail"] = harness.logTail.slice(-6_000);
		await harness.dispose();
		await warming?.catch(() => undefined);
		harness.assertNoRunners();
		observations["cleanup"] = harness.proof();
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/m1it-recoveryPending.json",
			JSON.stringify(observations, null, 2),
		);
	}
}, 60_000);
