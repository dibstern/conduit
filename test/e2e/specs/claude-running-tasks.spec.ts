// A turn that left background work running says so: its head shows "N running"
// beside the cost (nested tasks included) and the launching steps keep
// breathing on the strip after the turn's result, until the tasks finish. The
// session lists background agents beside shells in its tasks row and
// pull-down, nests an agent's tasks under it, reads as monitoring
// while they run. Task stops cross the real process runner in
// harness-background-task-stop.spec.ts; recorded replay has no stopTask replies.
// Spec: conduit-test-i7fy.8.
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

/** The live-task count sits in each turn's step-log footer: open the logs. */
async function openStepLogs(page: Page) {
	await expect(page.locator(".turn-activity-toggle").first()).toBeVisible();
	const collapsed = page.locator(
		'.turn-activity-toggle[aria-expanded="false"]',
	);
	while (await collapsed.count()) await collapsed.first().click();
	// A hovered head opens its tooltip, which repeats the count.
	await page.mouse.move(0, 0);
}

/** What the parent turn and the session say about live background work. */
async function readSurfaces(page: Page, sessionId: string) {
	const turn = page.locator(".turn-activity").first();
	const panel = page.getByTestId("background-tasks-panel");
	return {
		pill: (await page.locator(".turn-running").allTextContents()).map((text) =>
			text.replace(/\s+/g, " ").trim(),
		),
		breathing: await turn
			.locator('[aria-label^="Activity timeline"] .animate-pulse')
			.count(),
		sidebar: await page
			.locator(`#session-list [data-session-id="${sessionId}"]`)
			.getAttribute("aria-label"),
		tasksRow: (await page.getByTestId("background-tasks-row").isVisible())
			? await page.getByTestId("background-tasks-row").innerText()
			: null,
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

function recorder(
	page: Page,
	testInfo: TestInfo,
	sessionId: string,
	eventsDbPath: string,
) {
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
			const db = new DatabaseSync(eventsDbPath, { readOnly: true });
			try {
				const sessions = db
					.prepare("SELECT id, parent_id, side_thread, status FROM sessions")
					.all();
				const statuses = db
					.prepare(
						`SELECT sequence, session_id, created_at,
							json_extract(data, '$.status') AS status
						FROM events WHERE type = 'session.status'
						ORDER BY sequence DESC LIMIT 20`,
					)
					.all();
				writeFileSync(
					path,
					JSON.stringify({ sessionId, report, sessions, statuses }, null, 2),
				);
			} finally {
				db.close();
			}
			await testInfo.attach(name, { path, contentType: "application/json" });
		},
	};
}

test.describe("Claude running tasks", () => {
	test.use({ claudeReplay: replay });

	test("the step log counts its live tasks and the session monitors its agents until they finish", async ({
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
		const steps = recorder(page, testInfo, sessionId, harness.eventsDbPath);
		const pill = page.locator(".turn-running");
		const tasksRow = page.getByRole("button", {
			name: /^\d+ background tasks?$/,
		});
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
			await openStepLogs(page);

			// The parent's result: the shell, both agents and agent A's first
			// nested shell are live. The three launching steps still breathe.
			await expect(pill).toHaveText(/^\s*4\s+running\s*$/);
			await expect(tasksRow).toHaveAccessibleName("4 background tasks");
			await expect(
				page.getByRole("button", { name: "4 background tasks", exact: true }),
			).toBeVisible();
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
			await expect(tasksRow).toHaveAccessibleName("5 background tasks");
			await expect(
				page.getByRole("button", { name: "5 background tasks", exact: true }),
			).toBeVisible();
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
			await openStepLogs(page);
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
			await openStepLogs(page);
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
			await expect(
				page.getByRole("button", { name: /^\d+ background tasks?$/ }),
			).toHaveCount(0);
			await expect(sidebarRow).not.toHaveAttribute("aria-label", /^Monitoring/);
			const finished = await steps.record("finished");
			expect.soft(finished.breathing, "launching steps breathing").toBe(0);

			// A reload does not bring a finished task back.
			await page.reload();
			await expect
				.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
				.toContain("The top-level 40-second shell finished.");
			await openStepLogs(page);
			await expect(pill).toHaveCount(0);
			const reloaded = await steps.record("reloaded");
			expect.soft(reloaded.breathing, "launching steps breathing").toBe(0);
		} finally {
			await steps.write("running-tasks-report.json");
		}
	});
});
