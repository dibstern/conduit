// A step that launched a background task shows that task's real state, time
// and usage on one line, live and after a reload, and keeps telling the truth
// after the Claude process restarts. Spec: conduit-test-i7fy.7.
//
// Replays captured traces (no model call):
// - concurrent-background-work: a 40s shell, agent A (with two nested
//   background shells) and agent B, all launched before the parent's result,
//   then each finishing. Held at the parent's result and again while both of
//   agent A's nested shells are live, so "running" and "+2 tasks" are states
//   the test holds rather than races.
// - the same trace cut off by a restart before any launched task finishes, so
//   none of them ever reports an outcome.
// - foreground-agent-backgrounded: an agent started in the foreground and
//   moved to the background mid-run (its task_updated at line 34).
//
// The report lists every launching row at each step, live and reloaded, with
// a screenshot per step.

import { writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const SHELL = "toolu_01M42MfiCrNWfDuPGbsK4dUq";
const AGENT_A = "toolu_01U3biseGLup5XHSnDHKQqtC";
const AGENT_B = "toolu_015MfEiScHotw8NQSpASo57C";
const NESTED_SHELLS = [
	"toolu_012sQbH5FcjhYqyWS6bnMUHo",
	"toolu_01SZbHfa5rA1Ad32n4TCCjpQ",
];
const AGENT_F = "toolu_0183YenCXWVWywuLKM1XrPva";

type Row = {
	toolId: string;
	state: string | null;
	meta: string;
	step: string;
	nested: string;
	label: string;
};

/** Every tool row of the open session, with its launching-row fields. */
async function readRows(page: Page): Promise<Record<string, Row>> {
	// Finished turns fold their steps; open every log so each row renders. One
	// at a time: each click takes a toggle out of the matched set.
	const folded = page.locator(
		'.turn-activity-toggle[aria-expanded="false"]:visible',
	);
	while ((await folded.count()) > 0) await folded.first().click();
	const rows = await page
		.locator(".tool-item[data-tool-id]")
		.evaluateAll((nodes) =>
			nodes.map((node) => ({
				toolId: node.getAttribute("data-tool-id") ?? "",
				state: node.getAttribute("data-launch-state"),
				meta: node.querySelector(".launch-meta")?.textContent?.trim() ?? "",
				step: node.querySelector(".launch-step")?.textContent?.trim() ?? "",
				nested: node.querySelector(".launch-nested")?.textContent?.trim() ?? "",
				label: node.querySelector("button")?.getAttribute("aria-label") ?? "",
			})),
		);
	return Object.fromEntries(rows.map((row) => [row.toolId, row]));
}

function recorder(page: Page, testInfo: TestInfo) {
	const report: { step: string; rows: Record<string, Row> }[] = [];
	return {
		report,
		async record(step: string) {
			const rows = await readRows(page);
			report.push({ step, rows });
			const path = testInfo.outputPath(`${step}.png`);
			await page.screenshot({ path, animations: "disabled" });
			await testInfo.attach(`${step}.png`, { path, contentType: "image/png" });
			return rows;
		},
		async write(name: string) {
			const path = testInfo.outputPath(name);
			writeFileSync(path, JSON.stringify(report, null, 2));
			await testInfo.attach(name, { path, contentType: "application/json" });
		},
	};
}

/** Polls until the launching rows match, then records them. */
async function recordWhen(
	steps: ReturnType<typeof recorder>,
	page: Page,
	step: string,
	expected: Record<string, Partial<Record<keyof Row, unknown>>>,
) {
	await expect
		.poll(
			async () => {
				const rows = await readRows(page);
				return Object.fromEntries(
					Object.entries(expected).map(([id, fields]) => [
						id,
						Object.fromEntries(
							Object.keys(fields).map((key) => [
								key,
								rows[id]?.[key as keyof Row],
							]),
						),
					]),
				);
			},
			{ timeout: 30_000, message: step },
		)
		.toEqual(expected);
	return steps.record(step);
}

test.describe("Claude launching rows", () => {
	test.describe("finish", () => {
		test.use({
			claudeReplay: {
				turns: [
					"concurrent-background-work-turn",
					"concurrent-background-work-after-restart-turn",
				],
				holdAfterResult: true,
				// Both of agent A's nested shells are live; the first is about to end.
				holdBefore: { turn: 1, message: 104 },
			},
		});

		test("rows run, fold to their outcomes with real times, and survive a reload and a restart", async ({
			page,
			relayUrl,
			harness,
		}, testInfo) => {
			test.setTimeout(120_000);
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			const replayer = harness.claudeReplayer;
			if (!replayer) throw new Error("no Claude replayer");
			const steps = recorder(page, testInfo);
			try {
				await app.goto(relayUrl);
				await app.sendMessage("Launch the background work");
				await expect
					.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
					.toContain("launched.");
				await replayer.held();
				const launched = await recordWhen(steps, page, "parent-result", {
					[SHELL]: { state: "running" },
					[AGENT_A]: { state: "running" },
					[AGENT_B]: { state: "running" },
				});
				// A running row counts up from its start: a duration, no status word.
				expect.soft(launched[SHELL]?.meta).toMatch(/^(\d+ms|\d+s|\d+m \d+s)$/);
				expect.soft(launched[SHELL]?.label).toContain("running");

				replayer.release();
				await replayer.held();
				await chat.waitForStreamingComplete();
				// (d) agent A's nested shells are a count on agent A's row, not rows
				// of the parent.
				const nested = await recordWhen(steps, page, "nested-running", {
					[AGENT_A]: { state: "running", nested: "+2 tasks" },
					[AGENT_B]: { state: "running", nested: "" },
					[SHELL]: { state: "running", nested: "" },
				});
				for (const id of NESTED_SHELLS)
					expect
						.soft(nested[id], `nested shell ${id} in the parent`)
						.toBeUndefined();
				expect.soft(nested[AGENT_A]?.label).toContain("2 nested tasks running");

				// The SDK drops each task from its live list one message before
				// the task's outcome. No row may read "no longer running" between.
				await page.evaluate(() => {
					const seen: string[] = [];
					Object.assign(window, { goneLaunches: seen });
					new MutationObserver(() => {
						for (const node of document.querySelectorAll(
							'.tool-item[data-launch-state="gone"]',
						))
							seen.push(node.getAttribute("data-tool-id") ?? "");
					}).observe(document.body, {
						subtree: true,
						childList: true,
						attributes: true,
						attributeFilter: ["data-launch-state"],
					});
				});
				replayer.release();
				await expect
					.poll(() => chat.getLastAssistantText(), { timeout: 60_000 })
					.toContain("The top-level 40-second shell finished.");
				await chat.waitForStreamingComplete();
				// (a) each folds to its outcome with the SDK's time and usage. The
				// 40s shell reads seconds, not the milliseconds of its launch.
				const finished = await recordWhen(steps, page, "finished", {
					[SHELL]: { state: "completed", nested: "" },
					[AGENT_A]: { state: "completed", nested: "" },
					[AGENT_B]: { state: "completed", nested: "" },
				});
				expect.soft(finished[SHELL]?.meta).toMatch(/^done · (3[89]|4\d)s$/);
				expect
					.soft(finished[AGENT_A]?.meta)
					.toBe("done · 18s · 24k tokens · 6 tools");
				expect
					.soft(finished[AGENT_B]?.meta)
					.toBe("done · 22s · 18k tokens · 1 tool");
				expect.soft(finished[AGENT_A]?.label).toMatch(/done, 18s$/);
				expect
					.soft(
						await page.evaluate(
							() =>
								(window as unknown as { goneLaunches: string[] }).goneLaunches,
						),
						"rows that read no longer running before their outcome",
					)
					.toEqual([]);

				// (e) a reload derives the same rows from stored data.
				await page.reload();
				await expect
					.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
					.toContain("The top-level 40-second shell finished.");
				const reloaded = await recordWhen(steps, page, "reloaded", {
					[SHELL]: { state: "completed" },
				});
				for (const id of [SHELL, AGENT_A, AGENT_B])
					expect.soft(reloaded[id], `${id} after reload`).toEqual(finished[id]);

				// An outcome outlives the restart that empties the live list.
				await harness.restart();
				await gotoRelay(page, relayUrl);
				await app.sendMessage("Reply with only: ok, still here.");
				await expect
					.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
					.toContain("ok, still here.");
				const restarted = await steps.record("after-restart");
				for (const id of [SHELL, AGENT_A, AGENT_B])
					expect
						.soft(restarted[id], `${id} after restart`)
						.toEqual(finished[id]);
			} finally {
				await steps.write("launching-rows-report.json");
			}
		});
	});

	test.describe("restart", () => {
		test.use({
			claudeReplay: {
				turns: [
					"concurrent-background-work-turn",
					"concurrent-background-work-after-restart-turn",
				],
				// Agent A's nested shells are done; nothing the parent launched is.
				holdBefore: { turn: 1, message: 112 },
			},
		});

		test("rows with no outcome read No longer running after a restart", async ({
			page,
			relayUrl,
			harness,
		}, testInfo) => {
			test.setTimeout(120_000);
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			const replayer = harness.claudeReplayer;
			if (!replayer) throw new Error("no Claude replayer");
			const steps = recorder(page, testInfo);
			try {
				await app.goto(relayUrl);
				await app.sendMessage("Launch the background work");
				await expect
					.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
					.toContain("launched.");
				await replayer.held();
				await chat.waitForStreamingComplete();
				await recordWhen(steps, page, "before-restart", {
					[SHELL]: { state: "running" },
					[AGENT_A]: { state: "running", nested: "" },
					[AGENT_B]: { state: "running" },
				});

				// (c) the restart cuts the held trace off: no task reports an outcome.
				await harness.restart();
				await gotoRelay(page, relayUrl);
				await app.sendMessage("Reply with only: ok, still here.");
				await expect
					.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
					.toContain("ok, still here.");
				const gone = { state: "gone", nested: "" };
				const restarted = await recordWhen(steps, page, "after-restart", {
					[SHELL]: gone,
					[AGENT_A]: gone,
					[AGENT_B]: gone,
				});
				// Whatever usage an agent reported while running stays; no outcome is
				// made up for it.
				for (const id of [SHELL, AGENT_A, AGENT_B])
					expect
						.soft(restarted[id]?.meta, id)
						.toMatch(/^no longer running( · |$)/);
				await page.reload();
				await expect
					.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
					.toContain("ok, still here.");
				const reloaded = await recordWhen(
					steps,
					page,
					"after-restart-reloaded",
					{
						[SHELL]: gone,
					},
				);
				for (const id of [SHELL, AGENT_A, AGENT_B])
					expect
						.soft(reloaded[id], `${id} after reload`)
						.toEqual(restarted[id]);
			} finally {
				await steps.write("launching-rows-restart-report.json");
			}
		});
	});

	test.describe("backgrounded mid-run", () => {
		test.use({
			claudeReplay: {
				turns: ["foreground-agent-backgrounded-turn"],
				// Before the task_updated that moves agent F to the background.
				holdBefore: { turn: 1, message: 34 },
				holdAfterResult: true,
			},
		});

		test("a foreground agent moved to the background becomes a launching row", async ({
			page,
			relayUrl,
			harness,
		}, testInfo) => {
			test.setTimeout(120_000);
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			const replayer = harness.claudeReplayer;
			if (!replayer) throw new Error("no Claude replayer");
			const steps = recorder(page, testInfo);
			try {
				await app.goto(relayUrl);
				await app.sendMessage("Run agent F in the foreground");
				await replayer.held();
				// (b) a foreground agent is an ordinary step.
				await expect(
					page.locator(`.tool-item[data-tool-id="${AGENT_F}"]`),
				).toHaveCount(1, {
					timeout: 30_000,
				});
				const foreground = await recordWhen(steps, page, "foreground", {
					[AGENT_F]: { state: null, meta: "" },
				});
				expect.soft(foreground[AGENT_F]?.label).toBe("");

				replayer.release();
				await replayer.held();
				await recordWhen(steps, page, "backgrounded", {
					[AGENT_F]: { state: "running" },
				});

				replayer.release();
				await expect
					.poll(() => chat.getLastAssistantText(), { timeout: 60_000 })
					.toContain("done");
				await chat.waitForStreamingComplete();
				const finished = await recordWhen(steps, page, "finished", {
					[AGENT_F]: {
						state: "completed",
						meta: "done · 31s · 25k tokens · 5 tools",
					},
				});
				await page.reload();
				await expect
					.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
					.toContain("done");
				const reloaded = await recordWhen(steps, page, "reloaded", {
					[AGENT_F]: { state: "completed" },
				});
				expect.soft(reloaded[AGENT_F]).toEqual(finished[AGENT_F]);
			} finally {
				await steps.write("launching-rows-backgrounded-report.json");
			}
		});
	});
});
