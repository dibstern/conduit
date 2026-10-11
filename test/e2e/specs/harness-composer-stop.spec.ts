// Real browser/RPC/runner IPC, with the task-stop SDK's independent result and
// confirmation gates. Query marks prove continuity, including the runner PID.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
	responseChunks,
	taskStopFixture,
	taskStopMonitorFixture,
} from "../../helpers/fake-claude-process-sdk.js";
import type {
	ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

test.use({ harnessOptions: { restartProof: true } });

function marks(harness: ProcessHarness): Record<string, unknown>[] {
	const file = join(harness.root, "sdk-proof.ndjson");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const value: unknown = JSON.parse(line);
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error("Invalid SDK proof");
			return Object.fromEntries(Object.entries(value));
		});
}

test.afterEach(async ({ page, harness }, testInfo) => {
	const report = testInfo.outputPath("composer-stop-report.json");
	writeFileSync(
		report,
		JSON.stringify(
			{
				marks: marks(harness),
				queries: harness.claudeOptions(),
				runnerPids: harness.runnerPids(),
				generations: harness.generations.map(
					({ pid, port, fakeSdkActive, exitCode }) => ({
						pid,
						port,
						fakeSdkActive,
						exitCode,
					}),
				),
				buildIdentity: harness.rpcDiagnostics.buildIdentity,
				logTail: harness.logTail.slice(-4000),
				transcript: (await page.locator("#messages").innerText()).slice(-4000),
				tools: await page.locator(".tool-item").evaluateAll((tools) =>
					tools.map((tool) => ({
						id: tool.getAttribute("data-tool-id"),
						status: tool.getAttribute("data-tool-status"),
						text: tool.textContent,
					})),
				),
			},
			null,
			2,
		),
	);
	await testInfo.attach("composer-stop-report.json", {
		path: report,
		contentType: "application/json",
	});
	const screenshot = testInfo.outputPath("composer-stop-final.png");
	await page.screenshot({ path: screenshot, animations: "disabled" });
	await testInfo.attach("composer-stop-final.png", {
		path: screenshot,
		contentType: "image/png",
	});
});

function queryMarks(harness: ProcessHarness, queryId: string, kind: string) {
	return marks(harness).filter(
		(mark) => mark["queryId"] === queryId && mark["kind"] === kind,
	);
}

function cancel(browser: ProcessBrowser, sessionId: string) {
	return browser.rpc.CancelSession({
		projectSlug: "process-test",
		sessionId,
		commandId: randomUUID(),
	});
}

async function toolStatus(
	browser: ProcessBrowser,
	sessionId: string,
	toolId: string,
) {
	return (await browser.history(sessionId))
		.flatMap((message) => message.parts ?? [])
		.find((part) => part.id === toolId)?.state?.["status"];
}

async function start(
	page: import("@playwright/test").Page,
	harness: ProcessHarness,
	suffix = "turn-only",
) {
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Composer Stop proof");
	const app = new AppPage(page);
	const chat = new ChatPage(page);
	await app.goto(`${harness.baseUrl}/s/${sessionId}`);
	await app.sendMessage(`task-stop-foreground-${suffix}`);
	await expect
		.poll(() =>
			marks(harness).find(
				(mark) =>
					mark["kind"] === "task-stop-turn" && mark["phase"] === "streaming",
			),
		)
		.toBeDefined();
	const held = marks(harness).find(
		(mark) =>
			mark["kind"] === "task-stop-turn" && mark["phase"] === "streaming",
	);
	if (typeof held?.["queryId"] !== "string")
		throw new Error("Missing held query");
	const queryId = held["queryId"];
	const query = queryMarks(harness, queryId, "query")[0];
	expect(query?.["pid"]).not.toBe(harness.generations.at(-1)?.pid);
	expect(harness.runnerPids()).toContain(query?.["pid"]);
	await expect(chat.stopBtn).toBeVisible();
	return { browser, sessionId, app, chat, queryId, pid: query?.["pid"] };
}

test("composer Stop preserves tasks on both clients and Stop them waits for SDK confirmation", async ({
	page,
	harness,
}, testInfo) => {
	const { sessionId, chat, queryId } = await start(page, harness);
	const second = await page.context().newPage();
	await new AppPage(second).goto(`${harness.baseUrl}/s/${sessionId}`);
	try {
		await chat.stopBtn.click();
		await expect(chat.stopBtn).toBeHidden();
		const toast = page
			.getByTestId("toast")
			.filter({ hasText: "Turn stopped." });
		await expect(toast).toContainText("Turn stopped. 4 tasks still running");
		await expect(page.getByRole("alert")).toHaveCount(0);
		for (const client of [page, second]) {
			await expect(
				client.getByTestId("composer-task-dots").locator("i"),
			).toHaveCount(4);
			await client.getByTestId("background-tasks-row").click();
			await expect(
				client.getByTestId("background-task-description"),
			).toHaveText(taskStopFixture.map((task) => task.description));
		}
		await expect(
			second.getByTestId("toast").filter({ hasText: "Turn stopped." }),
		).toHaveCount(0);
		await page.getByTestId("background-tasks-row").click();
		const screenshot = testInfo.outputPath("turn-only-stop-toast.png");
		await page.screenshot({ path: screenshot, animations: "disabled" });
		await testInfo.attach("turn-only-stop-toast.png", {
			path: screenshot,
			contentType: "image/png",
		});
		await toast.getByRole("button", { name: "Stop them", exact: true }).click();
		await expect
			.poll(() =>
				marks(harness)
					.filter(
						(mark) =>
							mark["kind"] === "task-stop" && mark["phase"] === "requested",
					)
					.map((mark) => mark["taskId"]),
			)
			.toEqual([
				taskStopFixture[3].task_id,
				taskStopFixture[2].task_id,
				taskStopFixture[1].task_id,
				taskStopFixture[0].task_id,
			]);
		await expect(
			page.getByTestId("composer-task-dots").locator("i"),
		).toHaveCount(4);
		expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
		expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(1);
		writeFileSync(join(harness.root, "task-stop-confirm-all"), "release");
		for (const client of [page, second]) {
			await expect(client.getByTestId("background-tasks-row")).toBeHidden();
			await expect(client.getByTestId("composer-task-dots")).toBeHidden();
		}
		expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
	} finally {
		await second.close();
	}
});

test("queued tray stays Paused until Resume and the next message uses the same query and PID", async ({
	page,
	harness,
}) => {
	const { browser, sessionId, app, chat, queryId, pid } = await start(
		page,
		harness,
	);
	const next = "task-stop-follow-up-resumed";
	const inputId = randomUUID();
	expect(
		await Effect.runPromise(
			browser.rpc.input.submit({
				projectSlug: "process-test",
				sessionId,
				originId: browser.originId,
				inputId,
				text: next,
				delivery: "queue",
			}),
		),
	).toMatchObject({ ok: true });
	await expect(page.getByTestId("pending-input-text")).toHaveText(next);
	await chat.stopBtn.click();
	await expect(chat.stopBtn).toBeHidden();
	await expect(page.getByTestId("pending-input-paused")).toContainText(
		"Paused",
	);
	await expect(page.getByTestId("pending-input-text")).toHaveText(next);
	expect(
		marks(harness).filter(
			(mark) => mark["kind"] === "enqueue" && mark["request"] === next,
		),
	).toEqual([]);
	await page.getByTestId("pending-input-resume").click();
	await expect
		.poll(() => chat.getLastAssistantText())
		.toBe(responseChunks(next).join(""));
	await expect(chat.stopBtn).toBeHidden();
	await expect(page.getByTestId("pending-input-tray")).toHaveCount(0);
	await expect(page.getByTestId("composer-task-dots").locator("i")).toHaveCount(
		4,
	);
	const delivered = marks(harness).filter(
		(mark) => mark["kind"] === "enqueue" && mark["request"] === next,
	);
	expect(delivered).toHaveLength(1);
	expect(delivered[0]?.["queryId"]).toBe(queryId);
	expect(
		harness
			.claudeOptions()
			.filter((call) => call.prompt?.endsWith(next))
			.map((call) => call.pid),
	).toEqual([pid]);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
	expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(1);
	await expect(page.getByRole("alert")).toHaveCount(0);
	const sent = "task-stop-follow-up-next-message";
	await app.sendMessage(sent);
	await expect
		.poll(() => chat.getLastAssistantText())
		.toBe(responseChunks(sent).join(""));
	await expect(chat.stopBtn).toBeHidden();
	expect(
		marks(harness)
			.filter((mark) => mark["kind"] === "enqueue" && mark["request"] === sent)
			.map((mark) => mark["queryId"]),
	).toEqual([queryId]);
	expect(
		harness
			.claudeOptions()
			.filter((call) => call.prompt?.endsWith(sent))
			.map((call) => call.pid),
	).toEqual([pid]);
	await expect(page.getByTestId("composer-task-dots").locator("i")).toHaveCount(
		4,
	);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
});

test("a Monitor counts as live work and the toast disappears on session navigation", async ({
	page,
	harness,
	isMobile,
}) => {
	const { browser, chat, queryId } = await start(page, harness, "monitor");
	await chat.stopBtn.click();
	await expect(chat.stopBtn).toBeHidden();
	const toast = page.getByTestId("toast").filter({ hasText: "Turn stopped." });
	await expect(toast).toContainText("Turn stopped. 1 task still running");
	await page.getByTestId("background-tasks-row").click();
	await expect(page.getByTestId("background-task-description")).toHaveText([
		taskStopMonitorFixture[0].description,
	]);
	await page.getByRole("button", { name: "Close background tasks" }).click();
	await expect(page.getByTestId("background-tasks-scrim")).toBeHidden();
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
	const other = await browser.createSession("Another session");
	const row = page.locator(`[data-session-id="${other}"]`);
	if (isMobile) await page.getByTestId("session-bar-back").click();
	await row.locator(".session-item-title").click();
	await expect(page).toHaveURL(`${harness.baseUrl}/s/${other}`);
	await expect(
		page.getByTestId("toast").filter({ hasText: "Turn stopped." }),
	).toHaveCount(0);
	expect(marks(harness).filter((mark) => mark["kind"] === "task-stop")).toEqual(
		[],
	);
});

test("composer Stop with no live tasks closes the query and shows no task toast", async ({
	page,
	harness,
}) => {
	const { chat, queryId } = await start(page, harness, "no-tasks");
	await chat.stopBtn.click();
	await expect(chat.stopBtn).toBeHidden();
	await expect
		.poll(() => queryMarks(harness, queryId, "query-closed").length)
		.toBe(1);
	expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(1);
	await expect(
		page.getByTestId("toast").filter({ hasText: "Turn stopped." }),
	).toHaveCount(0);
	await expect(page.getByTestId("composer-task-dots")).toHaveCount(0);
});

test("correction: delayed idle cancel preserves the Monitor query and the next turn can Stop", async ({
	page,
	harness,
}) => {
	const { browser, sessionId, app, chat, queryId, pid } = await start(
		page,
		harness,
		"correction-idle-monitor",
	);
	writeFileSync(join(harness.root, "task-stop-release-result"), "release");
	await expect(chat.stopBtn).toBeHidden();
	await expect
		.poll(() => chat.getLastAssistantText())
		.toBe(
			responseChunks("task-stop-foreground-correction-idle-monitor").join(""),
		);
	expect(await Effect.runPromise(cancel(browser, sessionId))).toMatchObject({
		ok: true,
	});
	expect(queryMarks(harness, queryId, "query-interrupted")).toEqual([]);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
	unlinkSync(join(harness.root, "task-stop-release-result"));
	const next = "task-stop-foreground-correction-next-monitor";
	await app.sendMessage(next);
	await expect(chat.stopBtn).toBeVisible();
	await expect
		.poll(() =>
			marks(harness).some(
				(mark) =>
					mark["kind"] === "task-stop-turn" &&
					mark["phase"] === "streaming" &&
					mark["request"] === next,
			),
		)
		.toBe(true);
	await chat.stopBtn.click();
	await expect(chat.stopBtn).toBeHidden();
	expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(1);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
	expect(
		harness
			.claudeOptions()
			.filter((call) => call.prompt?.endsWith(next))
			.map((call) => call.pid),
	).toEqual([pid]);
	await expect(page.getByTestId("composer-task-dots").locator("i")).toHaveCount(
		1,
	);
});

test("correction: delayed idle cancel does not hide a real execution error on the next input", async ({
	page,
	harness,
}) => {
	const { browser, sessionId, app, chat, queryId } = await start(
		page,
		harness,
		"correction-idle-monitor",
	);
	writeFileSync(join(harness.root, "task-stop-release-result"), "release");
	await expect(chat.stopBtn).toBeHidden();
	await Effect.runPromise(cancel(browser, sessionId));
	await app.sendMessage("task-stop-correction-error");
	await expect(chat.stopBtn).toBeHidden();
	await expect(page.locator("#messages")).toContainText(
		"Fixture genuine execution failure",
	);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
	await expect(page.getByTestId("composer-task-dots").locator("i")).toHaveCount(
		1,
	);
});

test("correction: repeated cancel belongs to one input and Stop preserves the pending steer", async ({
	page,
	harness,
}) => {
	const { browser, sessionId, app, chat, queryId } = await start(
		page,
		harness,
		"correction-duplicate-monitor",
	);
	const steer = "task-stop-foreground-correction-steer-monitor";
	expect(
		await Effect.runPromise(
			browser.rpc.input.submit({
				projectSlug: "process-test",
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				text: steer,
				delivery: "steer",
			}),
		),
	).toMatchObject({ ok: true });
	await Effect.runPromise(cancel(browser, sessionId));
	await expect
		.poll(() => queryMarks(harness, queryId, "query-interrupted").length)
		.toBe(1);
	await Effect.runPromise(cancel(browser, sessionId));
	expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(1);
	writeFileSync(
		join(harness.root, "task-stop-correction-release-interrupted-result"),
		"release",
	);
	await expect
		.poll(() =>
			marks(harness).some(
				(mark) =>
					mark["kind"] === "task-stop-turn" &&
					mark["phase"] === "streaming" &&
					mark["request"] === steer,
			),
		)
		.toBe(true);
	await expect(chat.stopBtn).toBeVisible();
	await chat.stopBtn.click();
	await expect(chat.stopBtn).toBeHidden();
	expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(2);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
	await expect(page.getByTestId("composer-task-dots").locator("i")).toHaveCount(
		1,
	);
	await app.sendMessage("task-stop-follow-up-after-steer");
	await expect
		.poll(() => chat.getLastAssistantText())
		.toBe(responseChunks("task-stop-follow-up-after-steer").join(""));
});

test("correction: delayed cancel between a result and pending steer preserves the no-task query", async ({
	page,
	harness,
}) => {
	const { browser, sessionId, chat, queryId, pid } = await start(
		page,
		harness,
		"correction-steer-boundary-no-tasks",
	);
	const steer = "task-stop-follow-up-steer-boundary";
	expect(
		await Effect.runPromise(
			browser.rpc.input.submit({
				projectSlug: "process-test",
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				text: steer,
				delivery: "steer",
			}),
		),
	).toMatchObject({ ok: true });
	await Effect.runPromise(cancel(browser, sessionId));
	await expect
		.poll(() =>
			marks(harness).some(
				(mark) =>
					mark["kind"] === "task-stop-turn" && mark["phase"] === "after-result",
			),
		)
		.toBe(true);
	await expect(chat.stopBtn).toBeHidden();
	await Effect.runPromise(cancel(browser, sessionId));
	expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(1);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
	writeFileSync(
		join(harness.root, "task-stop-correction-release-steer"),
		"release",
	);
	await expect
		.poll(() => chat.getLastAssistantText())
		.toBe(responseChunks(steer).join(""));
	expect(
		marks(harness)
			.filter((mark) => mark["kind"] === "enqueue" && mark["request"] === steer)
			.map((mark) => mark["queryId"]),
	).toEqual([queryId]);
	expect(
		harness
			.claudeOptions()
			.filter((call) => call.prompt?.endsWith(steer))
			.map((call) => call.pid),
	).toEqual([pid]);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
});

test("correction: interrupt rejection reaches RPC and leaves the running tool intact", async ({
	page,
	harness,
}, testInfo) => {
	const { browser, sessionId, chat, queryId } = await start(
		page,
		harness,
		"correction-reject-monitor",
	);
	const tool = page.locator('.tool-item[data-tool-id="correction-foreground"]');
	const historyBeforeCancel = testInfo.outputPath(
		"foreground-tool-before-cancel.json",
	);
	writeFileSync(
		historyBeforeCancel,
		JSON.stringify(await browser.history(sessionId), null, 2),
	);
	await testInfo.attach("foreground-tool-before-cancel.json", {
		path: historyBeforeCancel,
		contentType: "application/json",
	});
	// The browser's terminal safety net can finalize cards locally. Verify the
	// authoritative tool state through the real history RPC as well as the UI.
	await expect
		.poll(() => toolStatus(browser, sessionId, "correction-foreground"))
		.toBe("running");
	const rejected = await Effect.runPromise(
		Effect.either(cancel(browser, sessionId)),
	);
	const rejectionPath = testInfo.outputPath("interrupt-rejection.json");
	writeFileSync(rejectionPath, JSON.stringify(rejected, null, 2));
	await testInfo.attach("interrupt-rejection.json", {
		path: rejectionPath,
		contentType: "application/json",
	});
	const historyAfterRejection = testInfo.outputPath(
		"foreground-tool-after-rejection.json",
	);
	writeFileSync(
		historyAfterRejection,
		JSON.stringify(await browser.history(sessionId), null, 2),
	);
	await testInfo.attach("foreground-tool-after-rejection.json", {
		path: historyAfterRejection,
		contentType: "application/json",
	});
	expect(rejected._tag).toBe("Left");
	await expect
		.poll(() => toolStatus(browser, sessionId, "correction-foreground"))
		.toBe("running");
	await chat.stopBtn.click();
	await expect(
		page.getByTestId("toast").filter({ hasText: "Failed to stop session" }),
	).toBeVisible();
	await expect(
		page.getByTestId("toast").filter({ hasText: "Turn stopped." }),
	).toHaveCount(0);
	await expect(chat.stopBtn).toBeVisible();
	await expect
		.poll(() => toolStatus(browser, sessionId, "correction-foreground"))
		.toBe("running");
	expect(queryMarks(harness, queryId, "query-interrupt-rejected")).toHaveLength(
		2,
	);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
	const screenshot = testInfo.outputPath(
		"interrupt-rejection-running-tool.png",
	);
	await page.screenshot({ path: screenshot, animations: "disabled" });
	await testInfo.attach("interrupt-rejection-running-tool.png", {
		path: screenshot,
		contentType: "image/png",
	});
	writeFileSync(
		join(harness.root, "task-stop-correction-allow-interrupt"),
		"release",
	);
	await chat.stopBtn.click();
	await expect(chat.stopBtn).toBeHidden();
	await expect
		.poll(() => toolStatus(browser, sessionId, "correction-foreground"))
		.toBe("completed");
	await chat.turnActivityToggles.last().click();
	await expect(tool).toHaveAttribute("data-tool-status", "completed");
	expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(1);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
});

test("correction: buffered foreground tools settle at the interrupted result", async ({
	page,
	harness,
}, testInfo) => {
	const { browser, sessionId, chat, queryId } = await start(
		page,
		harness,
		"correction-late-tool-monitor",
	);
	await chat.stopBtn.click();
	await expect(chat.stopBtn).toBeHidden();
	await expect
		.poll(() =>
			marks(harness).some(
				(mark) =>
					mark["kind"] === "task-stop-turn" && mark["phase"] === "late-tool",
			),
		)
		.toBe(true);
	const history = await browser.history(sessionId);
	const historyPath = testInfo.outputPath("interrupted-foreground-tools.json");
	writeFileSync(historyPath, JSON.stringify(history, null, 2));
	await testInfo.attach("interrupted-foreground-tools.json", {
		path: historyPath,
		contentType: "application/json",
	});
	expect(
		history
			.flatMap((message) => message.parts ?? [])
			.find((part) => part.id === "correction-late-foreground")?.state?.[
			"status"
		],
	).toBe("completed");
	await chat.turnActivityToggles.last().click();
	const tool = page.locator(
		'.tool-item[data-tool-id="correction-late-foreground"]',
	);
	await expect(tool).toBeVisible();
	await expect(tool).toHaveAttribute("data-tool-status", "completed");
	expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(1);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
	await expect(page.getByTestId("composer-task-dots").locator("i")).toHaveCount(
		1,
	);
});
