// Per-task stop travels from the real UI through the server and separate
// Claude runner. The fake SDK holds its confirmation and the foreground
// result independently, so removal and turn completion cannot race assertions.
// Recorded-query replay has no stopTask control, so this uses the process
// harness rather than pretending a replayed task was killed.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { Effect } from "effect";
import {
	responseChunks,
	taskStopFixture,
} from "../../helpers/fake-claude-process-sdk.js";
import type { ProcessHarness } from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const foreground = "task-stop-foreground";
const [shell, agent, nested] = taskStopFixture;

test.use({ harnessOptions: { restartProof: true } });

function readMarks(harness: ProcessHarness): Record<string, unknown>[] {
	const path = join(harness.root, "sdk-proof.ndjson");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const value: unknown = JSON.parse(line);
			if (typeof value !== "object" || value === null || Array.isArray(value))
				throw new Error("Invalid SDK proof record");
			return Object.fromEntries(Object.entries(value));
		});
}

// Hooks run before fixture disposal, including when startTurn fails before
// the per-step recorder exists.
test.afterEach(async ({ harness }, testInfo) => {
	const marks = readMarks(harness);
	const missingStreaming = !marks.some(
		(mark) =>
			mark["kind"] === "task-stop-turn" && mark["phase"] === "streaming",
	);
	const path = testInfo.outputPath("task-stop-sdk-diagnostics.json");
	writeFileSync(
		path,
		JSON.stringify(
			{
				marks: marks.map((mark) =>
					mark["kind"] === "query"
						? {
								kind: mark["kind"],
								queryId: mark["queryId"],
								sessionId: mark["sessionId"],
								pid: mark["pid"],
								at: mark["at"],
								options: mark["options"],
							}
						: mark,
				),
				queries: harness
					.claudeOptions()
					.map(({ pid, prompt, resumeId, options }) => ({
						pid,
						prompt,
						resumeId,
						model: options["model"],
						effort: options["effort"],
						permissionMode: options["permissionMode"],
						perTaskStopAffordance: options["perTaskStopAffordance"],
					})),
				runnerPids: harness.runnerPids(),
				...(missingStreaming
					? {
							startup: {
								buildIdentity: harness.rpcDiagnostics.buildIdentity,
								generations: harness.generations.map(
									({ pid, port, fakeSdkActive, exitCode, signal }) => ({
										pid,
										port,
										fakeSdkActive,
										exitCode,
										signal,
									}),
								),
								runnerMarks: harness.marks
									.filter((mark) =>
										[
											"runner-started",
											"runner-spawned",
											"runner-command",
										].includes(mark.kind),
									)
									.slice(-20),
								logTail: harness.logTail.slice(-4000),
							},
						}
					: {}),
			},
			null,
			2,
		),
	);
	await testInfo.attach("task-stop-sdk-diagnostics.json", {
		path,
		contentType: "application/json",
	});
});

function requestedIds(harness: ProcessHarness): string[] {
	return readMarks(harness).flatMap((mark) =>
		mark["kind"] === "task-stop" &&
		mark["phase"] === "requested" &&
		typeof mark["taskId"] === "string"
			? [mark["taskId"]]
			: [],
	);
}

function release(harness: ProcessHarness, name: string): void {
	writeFileSync(join(harness.root, name), "release");
}

function assertTurnUntouched(harness: ProcessHarness, queryId: string): void {
	expect(
		readMarks(harness).filter(
			(mark) =>
				mark["queryId"] === queryId &&
				["query-interrupted", "query-closed"].includes(String(mark["kind"])),
		),
	).toEqual([]);
}

async function expectTasks(page: Page, descriptions: readonly string[]) {
	await expect(
		page
			.getByTestId("background-tasks-panel")
			.getByTestId("background-task-description"),
	).toHaveText(descriptions);
	await expect(page.getByTestId("composer-task-dots").locator("i")).toHaveCount(
		descriptions.length,
	);
}

async function startTurn(
	page: Page,
	harness: ProcessHarness,
	prompt = foreground,
) {
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Task stop proof");
	const app = new AppPage(page);
	const chat = new ChatPage(page);
	await app.goto(`${harness.baseUrl}/s/${sessionId}`);
	await app.sendMessage(prompt);
	await expect
		.poll(() =>
			readMarks(harness).find(
				(mark) =>
					mark["kind"] === "task-stop-turn" && mark["phase"] === "streaming",
			),
		)
		.toBeDefined();
	const held = readMarks(harness).find(
		(mark) =>
			mark["kind"] === "task-stop-turn" && mark["phase"] === "streaming",
	);
	if (typeof held?.["queryId"] !== "string")
		throw new Error("No task-stop query ID");
	const queryId = held["queryId"];
	await expect(page.getByTestId("background-tasks-row")).toHaveAttribute(
		"aria-label",
		"4 background tasks",
	);
	await page.getByTestId("background-tasks-row").click();
	await expectTasks(
		page,
		taskStopFixture.map((task) => task.description),
	);
	await expect(
		page.getByTestId("background-task").filter({ hasText: nested.description }),
	).toHaveAttribute("data-depth", "1");
	const options = harness
		.claudeOptions()
		.find((call) => call.prompt === prompt);
	expect(options?.options["perTaskStopAffordance"]).toBe(true);
	expect(harness.runnerPids()).toContain(options?.pid);
	expect(options?.pid).not.toBe(harness.generations.at(-1)?.pid);
	return { browser, sessionId, app, chat, queryId };
}

function recorder(page: Page, harness: ProcessHarness, testInfo: TestInfo) {
	const steps: {
		step: string;
		rows: { description: string; depth: string | null }[];
		dots: number;
		headerVisible: boolean;
		transcript: string;
		marks: Record<string, unknown>[];
	}[] = [];
	return {
		async record(step: string) {
			steps.push({
				step,
				rows: await page
					.getByTestId("background-tasks-panel")
					.getByTestId("background-task")
					.evaluateAll((nodes) =>
						nodes.map((node) => ({
							description:
								node
									.querySelector('[data-testid="background-task-description"]')
									?.textContent?.trim() ?? "",
							depth: node.getAttribute("data-depth"),
						})),
					),
				dots: await page.getByTestId("composer-task-dots").locator("i").count(),
				headerVisible: await page
					.getByTestId("background-tasks-row")
					.isVisible(),
				transcript: (await page.locator("#messages").innerText()).slice(-4000),
				marks: readMarks(harness),
			});
			const path = testInfo.outputPath(`${step}.png`);
			await page.screenshot({ path, animations: "disabled" });
			await testInfo.attach(`${step}.png`, { path, contentType: "image/png" });
		},
		async write() {
			const path = testInfo.outputPath("task-stop-report.json");
			writeFileSync(
				path,
				JSON.stringify(
					{
						steps,
						marks: readMarks(harness),
						runnerPids: harness.runnerPids(),
						queries: harness
							.claudeOptions()
							.map(({ pid, prompt, options }) => ({
								pid,
								prompt,
								perTaskStopAffordance: options["perTaskStopAffordance"],
							})),
					},
					null,
					2,
				),
			);
			await testInfo.attach("task-stop-report.json", {
				path,
				contentType: "application/json",
			});
		},
	};
}

test("stops exactly one shell only after the SDK confirms it to both clients", async ({
	page,
	harness,
}, testInfo) => {
	const { sessionId, queryId, chat } = await startTurn(page, harness);
	const second = await page.context().newPage();
	const secondApp = new AppPage(second);
	const steps = recorder(page, harness, testInfo);
	try {
		await secondApp.goto(`${harness.baseUrl}/s/${sessionId}`);
		await expect(second.getByTestId("background-tasks-row")).toBeVisible();
		await second.getByTestId("background-tasks-row").click();
		await steps.record("four-live-tasks");
		await page
			.getByRole("button", { name: `Stop ${shell.description}`, exact: true })
			.click();
		await expect.poll(() => requestedIds(harness)).toEqual([shell.task_id]);
		await expectTasks(
			page,
			taskStopFixture.map((task) => task.description),
		);
		await expectTasks(
			second,
			taskStopFixture.map((task) => task.description),
		);
		await expect(page.getByTestId("task-drawer")).toHaveCount(0);
		assertTurnUntouched(harness, queryId);
		await steps.record("stop-acknowledged-tasks-still-live");
		release(harness, `task-stop-confirm-${shell.task_id}`);
		const remaining = taskStopFixture
			.filter((task) => task !== shell)
			.map((task) => task.description);
		await expectTasks(page, remaining);
		await expectTasks(second, remaining);
		await steps.record("one-task-confirmed-stopped");
		release(harness, "task-stop-release-result");
		await expect
			.poll(() => chat.getLastAssistantText())
			.toBe(responseChunks(foreground).join(""));
		await chat.waitForStreamingComplete();
		assertTurnUntouched(harness, queryId);
		await steps.record("foreground-result-preserved");
	} finally {
		await steps.write();
		await second.close();
	}
});

test("Stop all includes nested IDs and the foreground keeps streaming to its result", async ({
	page,
	harness,
}, testInfo) => {
	const { queryId, chat } = await startTurn(page, harness);
	const steps = recorder(page, harness, testInfo);
	try {
		await page.getByTestId("background-tasks-stop-all").click();
		await expect
			.poll(() => requestedIds(harness).slice().sort())
			.toEqual(taskStopFixture.map((task) => task.task_id).sort());
		await expectTasks(
			page,
			taskStopFixture.map((task) => task.description),
		);
		assertTurnUntouched(harness, queryId);
		await steps.record("all-stop-requests-tasks-still-live");
		release(harness, "task-stop-confirm-all");
		await expect(page.getByTestId("background-tasks-row")).toBeHidden();
		await expect(page.getByTestId("background-tasks-panel")).toBeHidden();
		await expect(page.getByTestId("composer-task-dots")).toBeHidden();
		await expect
			.poll(() => chat.getLastAssistantText())
			.toBe(responseChunks(foreground).slice(0, 2).join("").trimEnd());
		assertTurnUntouched(harness, queryId);
		await steps.record("tasks-gone-turn-still-streaming");
		release(harness, "task-stop-release-result");
		await expect
			.poll(() => chat.getLastAssistantText())
			.toBe(responseChunks(foreground).join(""));
		await chat.waitForStreamingComplete();
		assertTurnUntouched(harness, queryId);
		await steps.record("original-result");
	} finally {
		await steps.write();
	}
});

test("a steering message survives Stop all and runs after the original result", async ({
	page,
	harness,
}, testInfo) => {
	const { browser, sessionId, queryId, chat } = await startTurn(page, harness);
	const steer = "task-stop-follow-up-steer";
	const steps = recorder(page, harness, testInfo);
	try {
		const accepted = await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				text: steer,
				delivery: "steer",
			}),
		);
		expect(accepted.ok).toBe(true);
		await page.getByTestId("background-tasks-stop-all").click();
		await expect.poll(() => requestedIds(harness)).toHaveLength(4);
		await steps.record("steer-pending-after-stop-all");
		expect(
			readMarks(harness).filter(
				(mark) => mark["kind"] === "enqueue" && mark["request"] === steer,
			),
		).toEqual([]);
		assertTurnUntouched(harness, queryId);
		release(harness, "task-stop-confirm-all");
		await expect(page.getByTestId("background-tasks-row")).toBeHidden();
		expect(
			readMarks(harness).filter(
				(mark) => mark["kind"] === "enqueue" && mark["request"] === steer,
			),
		).toEqual([]);
		await steps.record("tasks-cleared-steer-still-pending");
		release(harness, "task-stop-release-result");
		await expect
			.poll(() => chat.getLastAssistantText())
			.toBe(responseChunks(steer).join(""));
		await chat.waitForStreamingComplete();
		const marks = readMarks(harness);
		const resultIndex = marks.findIndex(
			(mark) => mark["kind"] === "task-stop-turn" && mark["phase"] === "result",
		);
		const steerIndex = marks.findIndex(
			(mark) => mark["kind"] === "enqueue" && mark["request"] === steer,
		);
		expect(resultIndex).toBeGreaterThan(-1);
		expect(steerIndex).toBeGreaterThan(resultIndex);
		expect(marks[steerIndex]?.["queryId"]).toBe(queryId);
		expect(
			marks.filter(
				(mark) => mark["kind"] === "enqueue" && mark["request"] === steer,
			),
		).toHaveLength(1);
		await expect(chat.assistantMessages).toContainText([
			responseChunks(foreground).join(""),
			responseChunks(steer).join(""),
		]);
		assertTurnUntouched(harness, queryId);
		await steps.record("steer-completed-after-original-result");
	} finally {
		await steps.write();
	}
});

test("stopping an agent also stops its live descendants and leaves unrelated work", async ({
	page,
	harness,
}, testInfo) => {
	const { queryId, chat } = await startTurn(page, harness);
	const steps = recorder(page, harness, testInfo);
	try {
		await page
			.getByRole("button", { name: `Stop ${agent.description}`, exact: true })
			.click();
		await expect
			.poll(() => requestedIds(harness))
			.toEqual([nested.task_id, agent.task_id]);
		await expectTasks(
			page,
			taskStopFixture.map((task) => task.description),
		);
		await expect(page.getByTestId("task-drawer")).toHaveCount(0);
		await steps.record("agent-and-child-stop-requested");
		release(harness, "task-stop-confirm-all");
		await expectTasks(
			page,
			taskStopFixture
				.filter((task) => task !== agent && task !== nested)
				.map((task) => task.description),
		);
		assertTurnUntouched(harness, queryId);
		await steps.record("agent-subtree-gone-unrelated-shells-live");
		release(harness, "task-stop-release-result");
		await chat.waitForStreamingComplete();
		assertTurnUntouched(harness, queryId);
	} finally {
		await steps.write();
	}
});

test("Stop all works after the foreground result and leaves the same query usable", async ({
	page,
	harness,
}, testInfo) => {
	const { queryId, app, chat } = await startTurn(
		page,
		harness,
		"task-stop-foreground-idle",
	);
	const steps = recorder(page, harness, testInfo);
	try {
		release(harness, "task-stop-release-result");
		await chat.waitForStreamingComplete();
		await expect
			.poll(() =>
				readMarks(harness).find(
					(mark) =>
						mark["kind"] === "task-stop-turn" &&
						mark["phase"] === "after-result",
				),
			)
			.toBeDefined();
		await expectTasks(
			page,
			taskStopFixture.map((task) => task.description),
		);
		await steps.record("foreground-ended-tasks-live");
		await page.getByTestId("background-tasks-stop-all").click();
		await expect.poll(() => requestedIds(harness)).toHaveLength(4);
		await expectTasks(
			page,
			taskStopFixture.map((task) => task.description),
		);
		release(harness, "task-stop-confirm-all");
		await expect(page.getByTestId("background-tasks-row")).toBeHidden();
		await expect(page.getByTestId("composer-task-dots")).toBeHidden();
		assertTurnUntouched(harness, queryId);
		await steps.record("idle-tasks-confirmed-stopped");
		release(harness, "task-stop-release-input");
		const next = "task-stop-next-turn";
		await app.sendMessage(next);
		await expect
			.poll(() => chat.getLastAssistantText())
			.toBe(responseChunks(next).join(""));
		await chat.waitForStreamingComplete();
		const nextInput = readMarks(harness).find(
			(mark) => mark["kind"] === "enqueue" && mark["request"] === next,
		);
		expect(nextInput?.["queryId"]).toBe(queryId);
		assertTurnUntouched(harness, queryId);
		await steps.record("same-query-next-turn");
	} finally {
		await steps.write();
	}
});

test("a real failure keeps the row, duplicate clients and finished IDs are harmless", async ({
	page,
	harness,
}, testInfo) => {
	const { browser, sessionId, queryId, chat } = await startTurn(page, harness);
	const second = await page.context().newPage();
	const steps = recorder(page, harness, testInfo);
	const failGate = join(harness.root, `task-stop-fail-${shell.task_id}`);
	try {
		writeFileSync(failGate, "fail");
		await page
			.getByRole("button", { name: `Stop ${shell.description}`, exact: true })
			.click();
		await expect(
			page
				.locator('[role="alert"]')
				.filter({ hasText: /Failed to stop background tasks?/ }),
		).toBeVisible();
		await expectTasks(
			page,
			taskStopFixture.map((task) => task.description),
		);
		await steps.record("failure-toast-row-retained");
		unlinkSync(failGate);
		await new AppPage(second).goto(`${harness.baseUrl}/s/${sessionId}`);
		await second.getByTestId("background-tasks-row").click();
		await page
			.getByRole("button", { name: `Stop ${shell.description}`, exact: true })
			.click();
		await second
			.getByRole("button", { name: `Stop ${shell.description}`, exact: true })
			.click();
		await expect
			.poll(() => requestedIds(harness))
			.toEqual([shell.task_id, shell.task_id, shell.task_id]);
		await expectTasks(
			page,
			taskStopFixture.map((task) => task.description),
		);
		await steps.record("duplicate-clients-await-confirmation");
		release(harness, `task-stop-confirm-${shell.task_id}`);
		const remaining = taskStopFixture
			.filter((task) => task !== shell)
			.map((task) => task.description);
		await expectTasks(page, remaining);
		await expectTasks(second, remaining);
		const callsBeforeFinishedStop = requestedIds(harness);
		await Effect.runPromise(
			browser.rpc.StopBackgroundTask({
				sessionId,
				taskId: shell.task_id,
			}),
		);
		expect(requestedIds(harness)).toEqual(callsBeforeFinishedStop);
		await expect(second.locator('[role="alert"]')).toHaveCount(0);
		assertTurnUntouched(harness, queryId);
		await steps.record("finished-id-no-op");
		release(harness, "task-stop-release-result");
		await chat.waitForStreamingComplete();
		assertTurnUntouched(harness, queryId);
	} finally {
		await steps.write();
		await second.close();
	}
});
