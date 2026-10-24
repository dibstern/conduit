// Failures: a folder wait never places a failed user message, tears down
// background work, duplicates its timeout log, loses the draft, or cannot resend.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { responseChunks } from "../../helpers/fake-claude-process-sdk.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

test.use({ harnessOptions: { restartProof: true, logLevel: "warn" } });

test("folder admission places a failed message and restores a resendable draft", async ({
	page,
	harness,
}, testInfo) => {
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Send admission proof");
	await browser.preWarmSession(sessionId);
	const app = new AppPage(page);
	const chat = new ChatPage(page);
	const text = "m1it resend this after the folder change";
	const sdkMarks = () => {
		const path = join(harness.root, "sdk-proof.ndjson");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>)
			: [];
	};
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	const observations: Record<string, unknown> = { sessionId, text };
	try {
		await app.goto(`${harness.baseUrl}/s/${sessionId}`);
		await app.sendMessage("task-stop-foreground-idle");
		await expect(page.getByTestId("background-tasks-row")).toBeVisible();
		writeFileSync(join(harness.root, "task-stop-release-result"), "release");
		await expect
			.poll(() =>
				sdkMarks().some(
					(mark) =>
						mark["kind"] === "task-stop-turn" &&
						mark["phase"] === "after-result",
				),
			)
			.toBe(true);
		await chat.waitForStreamingComplete();
		const runnerPids = harness.runnerPids();
		const before = await Effect.runPromise(
			browser.rpc.ListDaemonSessions({ projectSlug: "process-test" }),
		);
		const tasksBefore = before.sessions.find(
			(session) => session.id === sessionId,
		)?.backgroundTasks;
		observations["backgroundTasksBefore"] = tasksBefore;
		const extra = join(harness.root, "extra");
		mkdirSync(extra);
		await Effect.runPromise(
			browser.rpc.SaveProject({
				slug: "process-test",
				folders: [harness.projectDir, extra],
			}),
		);
		await app.goto(`${harness.baseUrl}/s/${sessionId}`);
		// Startup closes its usage-probe query; only events after the send count.
		const marksBeforeSend = sdkMarks().length;
		const sentAt = Date.now();
		await app.sendMessage(text);
		await expect(chat.userMessages.filter({ hasText: text })).toHaveCount(1, {
			timeout: 2_000,
		});
		await expect(app.input).toHaveValue(text, { timeout: 2_000 });
		observations["refusedAfterMs"] = Date.now() - sentAt;
		expect(observations["refusedAfterMs"]).toBeGreaterThanOrEqual(900);
		expect(observations["refusedAfterMs"]).toBeLessThan(2_500);
		await expect(page.getByTestId("pending-input-tray")).toHaveCount(0);
		await expect(app.messages).toContainText("foldersPending");
		const failedMessage = db
			.prepare<[string], { input_id: string }>(
				"SELECT message.input_id FROM messages message JOIN provider_command_outbox command ON command.command_id = message.input_id AND command.session_id = message.session_id WHERE message.session_id = ? AND message.role = 'user' AND command.error_code = 'send_admission_timeout'",
			)
			.get(sessionId);
		expect(failedMessage).toBeDefined();
		const failedCommand = db
			.prepare<[string], { status: string; error_code: string | null }>(
				"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ?",
			)
			.get(failedMessage?.input_id ?? "");
		expect(failedCommand).toMatchObject({
			status: "failed",
			error_code: "send_admission_timeout",
		});
		observations["failedUserMessage"] = failedMessage;
		observations["failedCommand"] = failedCommand;
		await expect(page.getByTestId("background-tasks-row")).toBeVisible();
		const after = await Effect.runPromise(
			browser.rpc.ListDaemonSessions({ projectSlug: "process-test" }),
		);
		const tasksAfter = after.sessions.find(
			(session) => session.id === sessionId,
		)?.backgroundTasks;
		expect(tasksAfter).toEqual(tasksBefore);
		observations["backgroundTasksAfter"] = tasksAfter;
		expect(harness.runnerPids()).toEqual(runnerPids);
		expect(
			sdkMarks().filter(
				(mark) => mark["kind"] === "enqueue" && mark["request"] === text,
			),
		).toEqual([]);
		expect(
			sdkMarks()
				.slice(marksBeforeSend)
				.filter((mark) =>
					["query-interrupted", "query-closed"].includes(String(mark["kind"])),
				),
		).toEqual([]);
		const logs = harness.logTail
			.split("\n")
			.filter(
				(line) =>
					line.includes("send_admission_timeout") &&
					line.includes(`inputId=${failedMessage?.input_id}`),
			);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain(`sessionId=${sessionId}`);
		expect(logs[0]).toContain("reason=foldersPending");
		observations["admissionLogs"] = logs;
		observations["draft"] = await app.input.inputValue();
		observations["sdkBeforeResend"] = sdkMarks();
		await page.screenshot({ path: testInfo.outputPath("refused.png") });
		// Restore the original folder set so the same live query can take resend.
		await Effect.runPromise(
			browser.rpc.SaveProject({
				slug: "process-test",
				folders: [harness.projectDir],
			}),
		);
		writeFileSync(join(harness.root, "task-stop-confirm-all"), "release");
		writeFileSync(join(harness.root, "task-stop-release-input"), "release");
		await app.goto(`${harness.baseUrl}/s/${sessionId}`);
		await expect(app.input).toHaveValue(text);
		await app.sendBtn.click();
		await expect
			.poll(() => chat.getLastAssistantText())
			.toBe(responseChunks(text).join(""));
		await chat.waitForStreamingComplete();
		expect(
			sdkMarks().filter(
				(mark) => mark["kind"] === "enqueue" && mark["request"] === text,
			),
		).toHaveLength(1);
		observations["sdkAfterResend"] = sdkMarks();
		observations["outbox"] = db
			.prepare<[string], Record<string, unknown>>(
				"SELECT command_id, status, error_code FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
			)
			.all(sessionId);
	} finally {
		db.close();
		const path = testInfo.outputPath("send-admission.json");
		writeFileSync(path, JSON.stringify(observations, null, 2));
		await testInfo.attach("send-admission", {
			path,
			contentType: "application/json",
		});
	}
});
