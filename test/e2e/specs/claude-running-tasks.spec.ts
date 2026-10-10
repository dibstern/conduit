// A turn that left background work running says so: its head shows "N running"
// beside the cost (nested tasks included) and the launching steps keep
// breathing on the strip after the turn's result, until the tasks finish. The
// session lists background agents beside shells in its tasks row, composer
// dots and pull-down, nests an agent's tasks under it, reads as monitoring
// while they run, and Stop all ends agents and shells. Spec: conduit-test-i7fy.8.
//
// Replays a captured trace (no model call): concurrent-background-work, a 40s
// shell, agent A (with two nested background shells) and agent B, all launched
// before the parent's result, then each finishing. Held at the parent's
// result (shell, A, B and A's first nested shell live) and again while both of
// A's nested shells are live, so each count is a state the test holds.
//
// The report lists the turn head, strip and session surfaces at each step,
// with a screenshot per step.

import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Page, TestInfo } from "@playwright/test";
import type { ClaudeReplayPlan } from "../helpers/claude-trace-replayer.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const AGENT_A_TASK = "ab898d312e2e126b5";

const replay: ClaudeReplayPlan = {
	turns: ["concurrent-background-work-turn"],
	holdAfterResult: true,
	// Both of agent A's nested shells are live; the first is about to end.
	holdBefore: { turn: 1, message: 104 },
};

/** What the parent turn and the session say about live background work. */
async function readSurfaces(page: Page, sessionId: string) {
	const turn = page.locator(".turn-activity").first();
	const panel = page.getByTestId("background-tasks-panel");
	return {
		pill: (await page.locator(".turn-running").allTextContents()).map((text) =>
			text.replace(/\s+/g, " ").trim(),
		),
		breathing: await turn
			.locator('[aria-label^="Activity timeline"] button.animate-pulse')
			.count(),
		sidebar: await page
			.locator(`#session-list [data-session-id="${sessionId}"]`)
			.getAttribute("aria-label"),
		tasksRow: (await page.getByTestId("background-tasks-row").isVisible())
			? await page
					.getByTestId("background-tasks-row")
					.getAttribute("aria-label")
			: null,
		dots: await page.getByTestId("composer-task-dots").locator("i").count(),
		pulldown: (await panel.isVisible())
			? await panel.getByTestId("background-task").evaluateAll((nodes) =>
					nodes.map((node) => ({
						description:
							node
								.querySelector('[data-testid="background-task-description"]')
								?.textContent?.trim() ?? "",
						kind:
							node
								.querySelector('[data-testid="background-task-kind"]')
								?.textContent?.trim() ?? "",
						depth: Number(node.getAttribute("data-depth")),
					})),
				)
			: [],
	};
}

function recorder(page: Page, testInfo: TestInfo, sessionId: string) {
	const report: {
		step: string;
		surfaces: Awaited<ReturnType<typeof readSurfaces>>;
	}[] = [];
	return {
		async record(step: string) {
			const surfaces = await readSurfaces(page, sessionId);
			report.push({ step, surfaces });
			const path = testInfo.outputPath(`${step}.png`);
			await page.screenshot({ path, animations: "disabled" });
			await testInfo.attach(`${step}.png`, { path, contentType: "image/png" });
			return surfaces;
		},
		async write(name: string) {
			const path = testInfo.outputPath(name);
			writeFileSync(path, JSON.stringify({ sessionId, report }, null, 2));
			await testInfo.attach(name, { path, contentType: "application/json" });
		},
	};
}

test.describe("Claude running tasks", () => {
	test.use({ claudeReplay: replay });

	test("the turn head counts its live tasks and the session monitors its agents until they finish", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		test.setTimeout(120_000);
		const sessionId = decodeURIComponent(
			harness.projectUrl.slice("/s/".length),
		);
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const replayer = harness.claudeReplayer;
		if (!replayer) throw new Error("no Claude replayer");
		const steps = recorder(page, testInfo, sessionId);
		const pill = page.locator(".turn-running");
		const tasksRow = page.getByTestId("background-tasks-row");
		const sidebarRow = page.locator(
			`#session-list [data-session-id="${sessionId}"]`,
		);
		try {
			await app.goto(relayUrl);
			await app.sendMessage("Launch the background work");
			await expect
				.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
				.toContain("launched.");
			await replayer.held();

			// The parent's result: the shell, both agents and agent A's first
			// nested shell are live. The three launching steps still breathe.
			await expect(pill).toHaveText(/^\s*4\s+running\s*$/);
			await expect(tasksRow).toHaveAttribute(
				"aria-label",
				"4 background tasks",
			);
			await expect(
				page.getByTestId("composer-task-dots").locator("i"),
			).toHaveCount(4);
			const atResult = await steps.record("parent-result");
			expect.soft(atResult.breathing, "launching steps breathing").toBe(3);

			replayer.release();
			await replayer.held();
			await chat.waitForStreamingComplete();

			// Both of agent A's nested shells are live: counted once each.
			await expect(pill).toHaveText(/^\s*5\s+running\s*$/);
			await expect(
				sidebarRow,
				"background agents ran after the turn but the session did not read as monitoring",
			).toHaveAttribute("aria-label", /^Monitoring/);
			await expect(tasksRow).toHaveAttribute(
				"aria-label",
				"5 background tasks",
			);
			await expect(
				page.getByTestId("composer-task-dots").locator("i"),
			).toHaveCount(5);
			await tasksRow.click();
			await expect(page.getByTestId("background-tasks-panel")).toBeVisible();
			const nested = await steps.record("nested-running");
			expect.soft(nested.breathing, "launching steps breathing").toBe(3);
			// Agent A's two shells sit right under it, one level in; the rest
			// stand on their own.
			const depths = nested.pulldown.map((task) => task.depth);
			const agentRows = nested.pulldown.filter(
				(task) => task.kind === "subagent",
			);
			expect.soft(agentRows, "agents in the pull-down").toHaveLength(2);
			expect.soft(depths.filter((depth) => depth === 1)).toHaveLength(2);
			const firstNested = depths.indexOf(1);
			expect.soft(nested.pulldown[firstNested - 1]?.kind).toBe("subagent");
			expect.soft(nested.pulldown[firstNested + 1]?.depth).toBe(1);
			await tasksRow.click();

			// Agent A's Child Session reads the root's list: its own launches.
			const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
			const childId = (() => {
				try {
					return String(
						db
							.prepare(
								"SELECT id FROM sessions WHERE parent_id = ? AND provider_sid = ?",
							)
							.get(sessionId, AGENT_A_TASK)?.["id"],
					);
				} finally {
					db.close();
				}
			})();
			await gotoRelay(
				page,
				`${harness.relayBaseUrl}/s/${encodeURIComponent(childId)}`,
			);
			await expect(page.getByTestId("parent-session-status")).toHaveText(
				"Monitoring",
			);
			// Each of the agent's turns counts the shells it launched: one turn
			// with both, or two with one each, as the agent's turns fell.
			await expect
				.poll(
					async () =>
						(await pill.allTextContents()).reduce(
							(sum, text) => sum + Number.parseInt(text.trim(), 10),
							0,
						),
					{ message: "agent A's Child Session counts its nested shells" },
				)
				.toBe(2);
			await steps.record("child-session");
			await gotoRelay(page, relayUrl);
			await expect(pill).toHaveText(/^\s*5\s+running\s*$/);

			// Every task finishes: the pill goes, the strip settles, the session
			// stops monitoring.
			replayer.release();
			await expect
				.poll(() => chat.getLastAssistantText(), { timeout: 60_000 })
				.toContain("The top-level 40-second shell finished.");
			await chat.waitForStreamingComplete();
			await expect(pill).toHaveCount(0);
			await expect(tasksRow).toBeHidden();
			await expect(page.getByTestId("composer-task-dots")).toBeHidden();
			await expect(sidebarRow).not.toHaveAttribute("aria-label", /^Monitoring/);
			const finished = await steps.record("finished");
			expect.soft(finished.breathing, "launching steps breathing").toBe(0);

			// A reload does not bring a finished task back.
			await page.reload();
			await expect
				.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
				.toContain("The top-level 40-second shell finished.");
			await expect(pill).toHaveCount(0);
			const reloaded = await steps.record("reloaded");
			expect.soft(reloaded.breathing, "launching steps breathing").toBe(0);
		} finally {
			await steps.write("running-tasks-report.json");
		}
	});

	test("Stop all ends background agents and shells and the session stops monitoring", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		test.setTimeout(90_000);
		const sessionId = decodeURIComponent(
			harness.projectUrl.slice("/s/".length),
		);
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const replayer = harness.claudeReplayer;
		if (!replayer) throw new Error("no Claude replayer");
		const steps = recorder(page, testInfo, sessionId);
		const tasksRow = page.getByTestId("background-tasks-row");
		const sidebarRow = page.locator(
			`#session-list [data-session-id="${sessionId}"]`,
		);
		try {
			await app.goto(relayUrl);
			await app.sendMessage("Launch the background work");
			await expect
				.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
				.toContain("launched.");
			await replayer.held();
			replayer.release();
			await replayer.held();
			await chat.waitForStreamingComplete();
			await expect(tasksRow).toHaveAttribute(
				"aria-label",
				"5 background tasks",
			);
			await expect(sidebarRow).toHaveAttribute("aria-label", /^Monitoring/);
			await tasksRow.click();
			await steps.record("before-stop");

			await page.getByTestId("background-tasks-stop-all").click();
			await expect(
				tasksRow,
				"Stop all left the background tasks row up",
			).toBeHidden();
			await expect(page.getByTestId("composer-task-dots")).toBeHidden();
			await expect(page.locator(".turn-running")).toHaveCount(0);
			await expect(
				sidebarRow,
				"Stop all ended the agents but the sidebar still says monitoring",
			).not.toHaveAttribute("aria-label", /^Monitoring/);
			const stopped = await steps.record("after-stop");
			expect.soft(stopped.breathing, "launching steps breathing").toBe(0);
		} finally {
			await steps.write("stop-all-report.json");
		}
	});
});
