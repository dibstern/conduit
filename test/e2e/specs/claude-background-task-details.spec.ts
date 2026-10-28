import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page, TestInfo } from "@playwright/test";
import type { BackgroundTask } from "../../../src/lib/shared-types.js";
import { isRecord } from "../../../src/lib/utils.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const TRACE = "concurrent-background-work-turn";
const MONITOR_TOOL = "toolu_01SZbHfa5rA1Ad32n4TCCjpQ";
const LONG_COMMAND = `printf '%s\\n' '${"router-check ".repeat(24)}<script>task detail</script>'\necho finished`;

// Keep the capture's ownership ordering. Repeat known launchers with sparse
// observations, and add one unjoinable task to non-empty level snapshots.
const tracesDir = mkdtempSync(join(tmpdir(), "va96-task-details-"));
const endedTracesDir = mkdtempSync(join(tmpdir(), "va96-task-stream-end-"));
const fixtureDir = join(process.cwd(), "test/fixtures/claude-sdk-traces");
const rewriteInput = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(rewriteInput);
	if (!isRecord(value)) return value;
	if (value["type"] === "tool_use" && value["id"] === MONITOR_TOOL)
		return { ...value, input: { command: `${LONG_COMMAND}\necho initial` } };
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [key, rewriteInput(child)]),
	);
};
const capturedTrace = readFileSync(join(fixtureDir, `${TRACE}.jsonl`), "utf8");
const messages = capturedTrace
	.trim()
	.split("\n")
	.map((line) => {
		const message: unknown = rewriteInput(JSON.parse(line));
		if (!isRecord(message)) throw new Error("invalid trace message");
		if (
			message["subtype"] === "background_tasks_changed" &&
			Array.isArray(message["tasks"]) &&
			message["tasks"].length > 0
		)
			message["tasks"].push({
				task_id: "unjoinable",
				task_type: "local_workflow",
				description: "Unjoinable workflow",
			});
		return message;
	});

function launcherObservations(
	frame: Record<string, unknown> | undefined,
	inputs: readonly unknown[],
) {
	if (!frame || !isRecord(frame["message"]))
		throw new Error("missing launcher frame");
	const message = frame["message"];
	const content = message["content"];
	const tool = Array.isArray(content)
		? content.find(
				(block: unknown) => isRecord(block) && block["type"] === "tool_use",
			)
		: undefined;
	if (!isRecord(tool)) throw new Error("missing launcher tool");
	return inputs.map((input) => ({
		...frame,
		uuid: randomUUID(),
		message: {
			...message,
			id: `msg_${randomUUID()}`,
			content: [{ ...tool, input }],
		},
	}));
}

const monitorObservations = launcherObservations(messages[90], [
	{ command: LONG_COMMAND }, // A usable update must replace the original value.
	{},
	{ command: "" },
	{ command: 42 },
	null,
	{ command: " \n\t " },
]);
const sparseFrames = [
	...launcherObservations(messages[42], [
		{},
		{ subagent_type: "" },
		{ subagent_type: 42 },
		{ subagent_type: " \n\t " },
	]),
	// Stream input starts usable and ends sparse: this specifically exercises
	// rememberToolInput at content_block_stop, independently of registerIssuer.
	...[
		{
			type: "content_block_start",
			index: 0,
			content_block: {
				type: "tool_use",
				id: "toolu_01M42MfiCrNWfDuPGbsK4dUq",
				name: "Bash",
				input: { command: "sleep 40; echo top-shell-done" },
			},
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: {
				type: "input_json_delta",
				partial_json: JSON.stringify({ command: " \n\t " }),
			},
		},
		{ type: "content_block_stop", index: 0 },
	].map((event) => ({
		type: "stream_event",
		event,
		parent_tool_use_id: null,
		session_id: messages[0]?.["session_id"],
		uuid: randomUUID(),
	})),
	...monitorObservations,
];
messages.splice(103, 0, ...sparseFrames);
writeFileSync(
	join(tracesDir, `${TRACE}.jsonl`),
	messages.map((message) => JSON.stringify(message)).join("\n"),
);
const capturedReads = readFileSync(
	join(fixtureDir, `${TRACE}.subagent-reads.json`),
	"utf8",
);
const reads: unknown = rewriteInput(JSON.parse(capturedReads));
if (!Array.isArray(reads)) throw new Error("invalid transcript reads");
writeFileSync(
	join(tracesDir, `${TRACE}.subagent-reads.json`),
	JSON.stringify(
		reads.map((read: unknown) => {
			if (
				!isRecord(read) ||
				typeof read["afterMessage"] !== "number" ||
				!Array.isArray(read["messages"])
			)
				throw new Error("invalid transcript read");
			return {
				...read,
				afterMessage:
					read["afterMessage"] >= 104
						? read["afterMessage"] + sparseFrames.length
						: read["afterMessage"],
				messages:
					read["afterMessage"] >= 103 && read["agentId"] === "ab898d312e2e126b5"
						? [
								...read["messages"],
								...monitorObservations.map((frame) => ({
									...frame,
									parent_tool_use_id: null,
									parent_agent_id: null,
								})),
							]
						: read["messages"],
			};
		}),
	),
);
// End with a non-empty live set after agent A's notification and parent result.
writeFileSync(
	join(endedTracesDir, `${TRACE}.jsonl`),
	capturedTrace.trim().split("\n").slice(0, 124).join("\n"),
);
writeFileSync(
	join(endedTracesDir, `${TRACE}.subagent-reads.json`),
	capturedReads,
);
process.on("exit", () => {
	rmSync(tracesDir, { recursive: true, force: true });
	rmSync(endedTracesDir, { recursive: true, force: true });
});

function observeTasks(page: Page, sessionId: string) {
	let latest: readonly BackgroundTask[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const child of value) visit(child);
		} else if (isRecord(value)) {
			if (
				value["id"] === sessionId &&
				typeof value["title"] === "string" &&
				typeof value["status"] === "string"
			)
				latest = Array.isArray(value["backgroundTasks"])
					? (value["backgroundTasks"] as BackgroundTask[])
					: [];
			for (const child of Object.values(value)) visit(child);
		}
	};
	// Read only SubscribeShell rows, as the session store does. A family row is
	// read before a newer shell row yet can arrive after it, so last-arrival
	// across both streams shows a regression the UI never renders.
	const frames = (payload: string | Buffer) =>
		String(payload)
			.trim()
			.split("\n")
			.flatMap((line) => {
				try {
					const frame: unknown = JSON.parse(line);
					return isRecord(frame) ? [frame] : [];
				} catch {
					return []; // Non-JSON data-plane frames carry no session rows.
				}
			});
	page.on("websocket", (socket) => {
		const shellRequests = new Set<string>();
		socket.on("framesent", ({ payload }) => {
			for (const frame of frames(payload))
				if (frame["_tag"] === "Request" && frame["tag"] === "SubscribeShell")
					shellRequests.add(String(frame["id"]));
		});
		socket.on("framereceived", ({ payload }) => {
			for (const frame of frames(payload))
				if (shellRequests.has(String(frame["requestId"]))) visit(frame);
		});
	});
	return {
		get tasks() {
			return latest;
		},
		clear() {
			latest = [];
		},
	};
}

function evidence(page: Page, testInfo: TestInfo) {
	const steps: {
		step: string;
		tasks: readonly BackgroundTask[];
		rows: unknown;
		state?: unknown;
	}[] = [];
	return {
		async record(
			step: string,
			tasks: readonly BackgroundTask[],
			state?: unknown,
		) {
			const rows = await page
				.locator(
					'[data-testid="background-tasks-panel"], [data-testid="task-drawer"]',
				)
				.getByTestId("background-task")
				.evaluateAll((nodes) =>
					nodes.map((node) => {
						const detail = node.querySelector<HTMLElement>(
							'[data-testid="background-task-detail"]',
						);
						return {
							description: node.querySelector(
								'[data-testid="background-task-description"]',
							)?.textContent,
							kind: node.querySelector('[data-testid="background-task-kind"]')
								?.textContent,
							age: node.querySelector('[data-testid="background-task-age"]')
								?.textContent,
							depth: node.getAttribute("data-depth"),
							detail: detail?.textContent,
							title: detail?.title,
							width: detail?.clientWidth,
							fullWidth: detail?.scrollWidth,
							whiteSpace: detail && getComputedStyle(detail).whiteSpace,
							textOverflow: detail && getComputedStyle(detail).textOverflow,
						};
					}),
				);
			steps.push({
				step,
				tasks,
				rows,
				...(state === undefined ? {} : { state }),
			});
			const path = testInfo.outputPath(`${step}.png`);
			await page.screenshot({ path, animations: "disabled" });
			await testInfo.attach(step, { path, contentType: "image/png" });
		},
		async write() {
			const path = testInfo.outputPath("task-details-report.json");
			writeFileSync(path, JSON.stringify({ trace: TRACE, steps }, null, 2));
			await testInfo.attach("task-details-report", {
				path,
				contentType: "application/json",
			});
		},
	};
}

test.describe("Claude background task ages", () => {
	test.use({ claudeReplay: { turns: [TRACE], holdAfterResult: true } });
	test("reload restores the original task timestamps and advancing ages", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		test.setTimeout(120_000);
		const sessionId = decodeURIComponent(harness.projectUrl.slice(3));
		const snapshots = observeTasks(page, sessionId);
		const report = evidence(page, testInfo);
		const app = new AppPage(page);
		const replayer = harness.claudeReplayer;
		if (!replayer) throw new Error("no Claude replayer");
		try {
			await app.goto(relayUrl);
			await app.sendMessage("Launch the background work");
			await replayer.held();
			await expect.poll(() => snapshots.tasks.length).toBe(4);
			await expect(
				page.getByRole("button", { name: "4 background tasks", exact: true }),
			).toBeVisible();
			await page
				.getByRole("button", { name: /^\d+ background tasks?$/ })
				.click();
			await report.record("original", snapshots.tasks);
			const originalTasks = snapshots.tasks;
			const original = snapshots.tasks.map(({ id, firstSeenAt }) => ({
				id,
				firstSeenAt,
			}));
			// Advance browser time while the real runner remains held mid-task.
			const now = Date.now() + 12_000;
			await page.clock.setFixedTime(now);
			snapshots.clear();
			await page.reload();
			await expect.poll(() => snapshots.tasks.length).toBe(4);
			await page
				.getByRole("button", { name: /^\d+ background tasks?$/ })
				.click();
			await report.record("restored", snapshots.tasks);
			expect(
				snapshots.tasks.map(({ id, firstSeenAt }) => ({ id, firstSeenAt })),
			).toEqual(original);
			for (const task of originalTasks) {
				const seconds = Math.floor((now - task.firstSeenAt) / 1000);
				const row = page
					.getByTestId("background-tasks-panel")
					.getByTestId("background-task")
					.filter({
						has: page
							.getByTestId("background-task-description")
							.filter({ hasText: task.description }),
					});
				await expect(row.getByTestId("background-task-age")).toHaveText(
					seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`,
				);
			}
		} finally {
			replayer.release();
			await report.write();
		}
	});
});

for (const transcriptOnlySubagents of [false, true]) {
	test.describe(`Claude task detail via ${transcriptOnlySubagents ? "transcript feeds" : "SDK frames"}`, () => {
		test.use({
			claudeReplay: {
				turns: [TRACE],
				tracesDir,
				holdAfterResult: true,
				holdBefore: { turn: 1, message: 104 + sparseFrames.length },
				transcriptOnlySubagents,
			},
		});
		test("retains usable commands and agent types through sparse observations, later turns and reload", async ({
			page,
			relayUrl,
			harness,
		}, testInfo) => {
			test.setTimeout(120_000);
			await page.setViewportSize({ width: 393, height: 852 });
			const sessionId = decodeURIComponent(harness.projectUrl.slice(3));
			const snapshots = observeTasks(page, sessionId);
			const report = evidence(page, testInfo);
			const app = new AppPage(page);
			const replayer = harness.claudeReplayer;
			if (!replayer) throw new Error("no Claude replayer");
			try {
				await app.goto(relayUrl);
				await app.sendMessage("Launch the background work");
				await replayer.held();
				await expect.poll(() => snapshots.tasks.length).toBe(5);
				await page
					.getByRole("button", { name: /^\d+ background tasks?$/ })
					.click();
				const panel = page.getByTestId("background-tasks-panel");
				const row = (description: string) =>
					panel.getByTestId("background-task").filter({
						has: page
							.getByTestId("background-task-description")
							.filter({ hasText: description }),
					});
				await expect(
					row("Sleep 40 seconds then print done marker"),
				).toHaveCount(1);
				await expect(
					row("Sleep 40 seconds then print done marker").getByTestId(
						"background-task-detail",
					),
				).toHaveText("sleep 40; echo top-shell-done");
				for (const name of ["agent A", "agent B"])
					await expect(
						row(name).getByTestId("background-task-detail"),
					).toHaveText("general-purpose");
				await expect(
					row("Sleep 15 seconds then print a marker").getByTestId(
						"background-task-detail",
					),
				).toHaveText("sleep 15; echo nested-shell-done");
				await expect(
					row("Unjoinable workflow").getByTestId("background-task-kind"),
				).toHaveText("workflow");
				await expect(
					row("Unjoinable workflow").getByTestId("background-task-detail"),
				).toHaveCount(0);
				await report.record("parent-result", snapshots.tasks);
				await page
					.getByRole("button", { name: /^\d+ background tasks?$/ })
					.click();
				replayer.release();
				await replayer.held();
				await expect.poll(() => snapshots.tasks.length).toBe(6);
				await page
					.getByRole("button", { name: /^\d+ background tasks?$/ })
					.click();
				await expect(
					row("Sleep 40 seconds then print done marker").getByTestId(
						"background-task-detail",
					),
				).toHaveText("sleep 40; echo top-shell-done");
				await expect(
					row("agent A").getByTestId("background-task-detail"),
				).toHaveText("general-purpose");
				const detail = row(
					"wait for nested-shell-done in background task output",
				).getByTestId("background-task-detail");
				await expect(detail).toHaveAttribute("title", LONG_COMMAND);
				await expect(detail).toHaveText(LONG_COMMAND);
				await expect(detail.locator("script")).toHaveCount(0);
				const layout = await detail.evaluate((node) => ({
					width: node.clientWidth,
					fullWidth: node.scrollWidth,
					whiteSpace: getComputedStyle(node).whiteSpace,
					textOverflow: getComputedStyle(node).textOverflow,
				}));
				expect(layout.whiteSpace).toBe("nowrap");
				expect(layout.textOverflow).toBe("ellipsis");
				expect(layout.fullWidth).toBeGreaterThan(layout.width);
				await report.record("sparse-observations-later-turn", snapshots.tasks);
				const original = snapshots.tasks;
				snapshots.clear();
				await page.reload();
				await expect.poll(() => snapshots.tasks.length).toBe(6);
				await page
					.getByRole("button", { name: /^\d+ background tasks?$/ })
					.click();
				expect(snapshots.tasks).toEqual(original);
				await expect(detail).toHaveAttribute("title", LONG_COMMAND);
				await report.record("restored-details", snapshots.tasks);
				await page.setViewportSize({ width: 1440, height: 900 });
				// The phone sheet glides out while the desktop panel mounts, so
				// both panels exist until the sheet's dialog is gone.
				await expect(
					page.getByRole("dialog", { name: "Background tasks" }),
				).toHaveCount(0);
				await expect(panel).toHaveCount(1);
				if (!(await panel.isVisible()))
					await page
						.getByRole("button", { name: /^\d+ background tasks?$/ })
						.click();
				await panel.getByRole("button", { name: "Open agent A" }).click();
				const drawer = page.getByTestId("task-drawer");
				await expect(drawer).toBeVisible();
				await expect(page.getByTestId("task-drawer-selected")).toContainText(
					"agent A",
				);
				await expect(
					drawer.getByTestId("background-task-detail").filter({
						hasText: "router-check",
					}),
				).toHaveAttribute("title", LONG_COMMAND);
				await report.record("task-drawer-details", snapshots.tasks);
			} finally {
				replayer.release();
				// On an early assertion failure the second hold may not be reached yet.
				replayer.release();
				await report.write();
			}
		});
	});
}

test.describe("Claude ended stream task liveness", () => {
	test.use({
		claudeReplay: {
			turns: [TRACE],
			tracesDir: endedTracesDir,
			holdAfterResult: true,
			transcriptOnlySubagents: true,
			endAfterTrace: true,
			holdSubagentReadAfter: {
				turn: 1,
				// task_updated completes A before the following task_notification.
				// Its completion schedules the sole final transcript read.
				message: 113,
				agentId: "ab898d312e2e126b5",
			},
		},
	});
	test("a delayed final transcript persists history without reviving ended tasks", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		test.setTimeout(120_000);
		const sessionId = decodeURIComponent(harness.projectUrl.slice(3));
		const snapshots = observeTasks(page, sessionId);
		const report = evidence(page, testInfo);
		const app = new AppPage(page);
		const replayer = harness.claudeReplayer;
		if (!replayer) throw new Error("no Claude replayer");
		try {
			await app.goto(relayUrl);
			await app.sendMessage("Launch the background work");
			await replayer.held();
			await expect.poll(() => snapshots.tasks.length).toBe(4);
			await page
				.getByRole("button", { name: /^\d+ background tasks?$/ })
				.click();
			await expect(
				page.getByRole("button", { name: "4 background tasks", exact: true }),
			).toBeVisible();
			await report.record("live-before-stream-end", snapshots.tasks);
			const childId = snapshots.tasks.find(
				(task) => task.description === "agent A",
			)?.childSessionId;
			const siblingId = snapshots.tasks.find(
				(task) => task.description === "agent B",
			)?.childSessionId;
			if (!childId || !siblingId)
				throw new Error("agents have no child sessions");
			const siblingStatus = () => {
				const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
				try {
					return db
						.prepare("SELECT status FROM sessions WHERE id = ?")
						.get(siblingId)?.["status"];
				} finally {
					db.close();
				}
			};
			expect(siblingStatus()).toBe("busy");
			// Live polls may already have persisted agent A's prompt, which ends in
			// "A done." too; only the final transcript carries the reply itself.
			const finalHistoryCount = () => {
				const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
				try {
					return Number(
						db
							.prepare(
								// The launch prompt also contains "A done."; only the final
								// assistant text is exactly this captured response.
								"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'text.delta' AND json_extract(data, '$.text') = ?",
							)
							.get(childId, "A done.")?.["n"],
					);
				} finally {
					db.close();
				}
			};
			snapshots.clear();
			replayer.release();
			await replayer.held();
			// Agent B has no completion in this cut trace. Its persisted idle state
			// proves stream teardown ran while agent A's final read is still held.
			await expect.poll(siblingStatus).toBe("idle");
			expect(finalHistoryCount()).toBe(0);
			await report.record("stream-ended-final-read-held", snapshots.tasks, {
				childSessionId: childId,
				siblingSessionId: siblingId,
				siblingStatus: siblingStatus(),
				finalHistoryCount: finalHistoryCount(),
			});
			replayer.release();
			await expect.poll(finalHistoryCount).toBeGreaterThan(0);
			// Subscribe again after final history arrives, proving the restored
			// session snapshot also stays empty once the delayed callback runs.
			snapshots.clear();
			await page.reload();
			await page.locator("#layout").waitFor({ state: "attached" });
			await page.locator("#connect-overlay").waitFor({ state: "hidden" });
			await report.record("final-history-restored", snapshots.tasks, {
				childSessionId: childId,
				finalHistoryCount: finalHistoryCount(),
			});
			await expect(page.getByTestId("background-tasks-row")).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: /^\d+ background tasks?$/ }),
			).toHaveCount(0);
			expect(snapshots.tasks).toEqual([]);
		} finally {
			replayer.release();
			replayer.release();
			await report.write();
		}
	});
});
