// Real browser/RPC/runner IPC, with the task-stop SDK's independent result and
// confirmation gates. Query marks prove continuity, including the runner PID.
// Run with --workers=1 to collect all stop-and-run scenarios in one JSON artifact.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TestInfo } from "@playwright/test";
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
	if (testInfo.title.startsWith("stop and run:"))
		recordStopAndRun(harness, testInfo);
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

function recordStopAndRun(harness: ProcessHarness, testInfo: TestInfo) {
	const artifact = join("test-results", "7hjw-stop-and-run.json");
	mkdirSync("test-results", { recursive: true });
	const previous: unknown = existsSync(artifact)
		? JSON.parse(readFileSync(artifact, "utf8"))
		: {};
	if (!previous || typeof previous !== "object" || Array.isArray(previous))
		throw new Error("Invalid stop-and-run artifact");
	const observed = marks(harness);
	writeFileSync(
		artifact,
		JSON.stringify(
			{
				...previous,
				[`${testInfo.project.name}/${testInfo.title}`]: {
					status: testInfo.status,
					requests: observed
						.filter((mark) => mark["kind"] === "enqueue")
						.map((mark) => mark["request"]),
					interruptObserved: observed.some(
						(mark) => mark["kind"] === "query-interrupted",
					),
				},
			},
			null,
			2,
		),
	);
}

function cancel(browser: ProcessBrowser, sessionId: string) {
	return browser.rpc.CancelSession({
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
	const sentAt = await page.evaluate(() => performance.now());
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
	// The composer arms Stop 1.5s after an idle Send click.
	await page.waitForFunction(
		(sent) => performance.now() - sent >= 1500,
		sentAt,
	);
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
				client.getByRole("button", { name: "4 background tasks", exact: true }),
			).toBeVisible();
			await client
				.getByRole("button", { name: /^\d+ background tasks?$/ })
				.click();
			await expect(
				client.getByTestId("background-task-description"),
			).toHaveText(taskStopFixture.map((task) => task.description));
		}
		await expect(
			second.getByTestId("toast").filter({ hasText: "Turn stopped." }),
		).toHaveCount(0);
		await page.getByRole("button", { name: /^\d+ background tasks?$/ }).click();
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
			page.getByRole("button", { name: "4 background tasks", exact: true }),
		).toBeVisible();
		expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
		expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(1);
		writeFileSync(join(harness.root, "task-stop-confirm-all"), "release");
		for (const client of [page, second]) {
			await expect(client.getByTestId("background-tasks-row")).toBeHidden();
			await expect(
				client.getByRole("button", { name: /^\d+ background tasks?$/ }),
			).toHaveCount(0);
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
			browser.rpc["input.submit"]({
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
	await expect(
		page.getByRole("button", { name: "4 background tasks", exact: true }),
	).toBeVisible();
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
	await expect(
		page.getByRole("button", { name: "4 background tasks", exact: true }),
	).toBeVisible();
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
});

test("stop and run: a slash command interrupts a never-ending turn from the composer", async ({
	page,
	harness,
}) => {
	const { app, chat, queryId } = await start(page, harness);
	await app.input.fill("/goal clear");
	await app.input.press("ControlOrMeta+Enter");
	await expect
		.poll(() => queryMarks(harness, queryId, "query-interrupted").length)
		.toBe(1);
	await expect
		.poll(() =>
			marks(harness)
				.filter((mark) => mark["kind"] === "enqueue")
				.map((mark) => mark["request"]),
		)
		.toEqual(["task-stop-foreground-turn-only", "/goal clear"]);
	await expect(app.input).toHaveValue("");
	await expect(page.getByTestId("composer-steer-refused")).toHaveCount(0);
	await expect(chat.stopBtn).toBeHidden();
	await expect(page.getByTestId("pending-input-tray")).toHaveCount(0);
});

test("stop and run: Run now sends the command ahead of the queued message and drains both", async ({
	page,
	harness,
	isMobile,
}) => {
	const { app, chat, queryId } = await start(page, harness);
	for (const text of ["after-command", "/goal clear"]) {
		await app.input.fill(text);
		// Mobile Enter inserts a newline; its Send button uses the same queue delivery.
		if (isMobile) await app.sendBtn.click();
		else await app.input.press("Enter");
	}
	await expect(page.getByTestId("pending-input-text")).toHaveText([
		"after-command",
		"/goal clear",
	]);
	const command = page
		.getByTestId("pending-input-row")
		.filter({ hasText: "/goal clear" });
	await expect(command.getByTestId("pending-input-steer")).toHaveCount(0);
	await expect(command.getByTestId("pending-input-run-now")).toHaveText(
		"Run now",
	);
	await command.getByRole("button", { name: "Run now", exact: true }).click();
	await expect
		.poll(() => queryMarks(harness, queryId, "query-interrupted").length)
		.toBe(1);
	await expect
		.poll(() =>
			marks(harness)
				.filter((mark) => mark["kind"] === "enqueue")
				.map((mark) => mark["request"]),
		)
		.toEqual([
			"task-stop-foreground-turn-only",
			"/goal clear",
			"after-command",
		]);
	await expect
		.poll(() => chat.getLastAssistantText())
		.toBe(responseChunks("after-command").join(""));
	await expect(chat.stopBtn).toBeHidden();
	await expect(page.getByTestId("pending-input-tray")).toHaveCount(0);
});

test("stop and run: an open question still refuses the command without interrupting", async ({
	page,
	harness,
}) => {
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Stop-and-run question proof");
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}/s/${sessionId}`);
	await app.sendMessage("question-stop-and-run");
	await expect(page.locator(".question-card")).toBeVisible();
	await app.input.fill("/goal clear");
	await app.input.press("ControlOrMeta+Enter");
	await expect(page.getByTestId("composer-steer-refused")).toContainText(
		"Answer the open prompt first.",
	);
	await expect(app.input).toHaveValue("/goal clear");
	await expect(page.locator(".question-card")).toBeVisible();
	await expect(page.getByTestId("pending-input-tray")).toHaveCount(0);
	expect(
		marks(harness)
			.filter((mark) => mark["kind"] === "enqueue")
			.map((mark) => mark["request"]),
	).toEqual(["question-stop-and-run"]);
	expect(
		marks(harness).filter((mark) => mark["kind"] === "query-interrupted"),
	).toEqual([]);
});

test("stop and run: an interrupt failure keeps the command queued and first when the turn ends", async ({
	page,
	harness,
}) => {
	const { app, chat, queryId } = await start(
		page,
		harness,
		"correction-reject-monitor",
	);
	await app.sendMessage("after-command");
	await app.input.fill("/goal clear");
	await app.input.press("ControlOrMeta+Enter");
	await expect
		.poll(() => queryMarks(harness, queryId, "query-interrupt-rejected").length)
		.toBe(1);
	await expect(app.input).toHaveValue("");
	await expect(page.getByTestId("composer-steer-refused")).toHaveCount(0);
	await expect(chat.stopBtn).toBeVisible();
	await expect(page.getByTestId("pending-input-text")).toHaveText([
		"after-command",
		"/goal clear",
	]);
	writeFileSync(join(harness.root, "task-stop-release-result"), "release");
	await expect
		.poll(() =>
			marks(harness)
				.filter((mark) => mark["kind"] === "enqueue")
				.map((mark) => mark["request"]),
		)
		.toEqual([
			"task-stop-foreground-correction-reject-monitor",
			"/goal clear",
			"after-command",
		]);
	await expect(chat.stopBtn).toBeHidden();
	await expect(page.getByTestId("pending-input-tray")).toHaveCount(0);
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
	await page.getByRole("button", { name: /^\d+ background tasks?$/ }).click();
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
	await expect(
		page.getByRole("button", { name: /^\d+ background tasks?$/ }),
	).toHaveCount(0);
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
	const nextSentAt = await page.evaluate(() => performance.now());
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
	await page.waitForFunction(
		(sent) => performance.now() - sent >= 1500,
		nextSentAt,
	);
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
	await expect(
		page.getByRole("button", { name: "1 background task", exact: true }),
	).toBeVisible();
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
	await expect(
		page.getByRole("button", { name: "1 background task", exact: true }),
	).toBeVisible();
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
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				text: steer,
				delivery: "steer",
			}),
		),
	).toMatchObject({ ok: true });
	let stopsCompleted = 0;
	const stopping = Effect.runPromise(cancel(browser, sessionId)).then(
		(result) => {
			stopsCompleted++;
			return result;
		},
	);
	await expect
		.poll(() => queryMarks(harness, queryId, "query-interrupted").length)
		.toBe(1);
	const repeated = Effect.runPromise(cancel(browser, sessionId)).then(
		(result) => {
			stopsCompleted++;
			return result;
		},
	);
	// A later RPC observes the session while both Stops await the held terminal.
	await browser.history(sessionId);
	expect(stopsCompleted).toBe(0);
	expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(1);
	writeFileSync(
		join(harness.root, "task-stop-correction-release-interrupted-result"),
		"release",
	);
	expect(await stopping).toMatchObject({ ok: true });
	expect(await repeated).toMatchObject({ ok: true });
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
	await expect(
		page.getByRole("button", { name: "1 background task", exact: true }),
	).toBeVisible();
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
			browser.rpc["input.submit"]({
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

test("correction: interrupt rejection keeps Stop pending until the SDK terminal", async ({
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
	let stopCompleted = false;
	const stopping = Effect.runPromise(cancel(browser, sessionId)).then(
		(result) => {
			stopCompleted = true;
			return result;
		},
	);
	await expect
		.poll(() => queryMarks(harness, queryId, "query-interrupt-rejected").length)
		.toBe(1);
	const rejectionPath = testInfo.outputPath("interrupt-rejection.json");
	writeFileSync(
		rejectionPath,
		JSON.stringify(
			{
				stopPending: !stopCompleted,
				marks: queryMarks(harness, queryId, "query-interrupt-rejected"),
			},
			null,
			2,
		),
	);
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
	expect(stopCompleted).toBe(false);
	await expect
		.poll(() => toolStatus(browser, sessionId, "correction-foreground"))
		.toBe("running");
	await expect(
		page.getByTestId("toast").filter({ hasText: "Failed to stop session" }),
	).toHaveCount(0);
	await expect(
		page.getByTestId("toast").filter({ hasText: "Turn stopped." }),
	).toHaveCount(0);
	await expect(chat.stopBtn).toBeVisible();
	await expect
		.poll(() => toolStatus(browser, sessionId, "correction-foreground"))
		.toBe("running");
	expect(queryMarks(harness, queryId, "query-interrupt-rejected")).toHaveLength(
		1,
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
	writeFileSync(join(harness.root, "task-stop-release-result"), "release");
	// A rejected SDK control cannot synthesize a terminal or abandon durable Stop.
	expect(await stopping).toMatchObject({ ok: true });
	await expect(chat.stopBtn).toBeHidden();
	await expect
		.poll(() => toolStatus(browser, sessionId, "correction-foreground"))
		.toBe("completed");
	await chat.turnActivityToggles.last().click();
	await expect(tool).toHaveAttribute("data-tool-status", "completed");
	expect(queryMarks(harness, queryId, "query-interrupted")).toHaveLength(0);
	expect(queryMarks(harness, queryId, "query-closed")).toEqual([]);
	await expect(
		page.getByRole("button", { name: "1 background task", exact: true }),
	).toBeVisible();
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
	await expect(
		page.getByRole("button", { name: "1 background task", exact: true }),
	).toBeVisible();
});
