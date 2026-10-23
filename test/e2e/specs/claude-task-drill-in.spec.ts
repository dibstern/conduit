// Tapping a background task opens it. The session's one task list (the
// pull-down) and a turn's launching rows both drill in. On desktop the task
// opens in a drawer beside the transcript: the same list with the selected
// task's Child Session transcript beneath, live while the task runs, and
// closing it leaves the parent exactly as it was. On a phone the Child Session
// opens full screen and its back bar returns to where the tap came from. Shell
// rows have nothing to open and only read. Spec: conduit-test-i7fy.10.
//
// Replays a captured trace (no model call): concurrent-background-work, held
// while agent A's two nested shells run and agent A is still working, so the
// drawer can show agent A's transcript before and after its last reply.
//
// The report lists the drawer, list and parent state at each step, with a
// screenshot per step.

import { writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import type { ClaudeReplayPlan } from "../helpers/claude-trace-replayer.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

/** The Agent call that launched agent A in the background. */
const AGENT_A_TOOL = "toolu_01U3biseGLup5XHSnDHKQqtC";
/** Agent A's last words, which arrive only after the hold is released. Its
 * prompt quotes them too, so look for them only in its replies. */
const AGENT_A_REPLY = "A done.";

const replay: ClaudeReplayPlan = {
	turns: ["concurrent-background-work-turn"],
	holdAfterResult: true,
	// Both of agent A's nested shells are live; agent A has not replied yet.
	holdBefore: { turn: 1, message: 104 },
};

/** What the page says about the task list, the drawer and the open session. */
async function readState(page: Page) {
	const drawer = page.getByTestId("task-drawer");
	const list = page.locator(
		"[data-testid='background-tasks-panel'], [data-testid='task-drawer']",
	);
	return {
		url: new URL(page.url()).pathname,
		parentScrollTop: await page
			.locator("#messages")
			.evaluate((node) => node.scrollTop)
			.catch(() => null),
		pulldownOpen: await page.getByTestId("background-tasks-panel").isVisible(),
		rows: await list.getByTestId("background-task").evaluateAll((nodes) =>
			nodes.map((node) => ({
				description:
					node
						.querySelector("[data-testid='background-task-description']")
						?.textContent?.trim() ?? "",
				kind:
					node
						.querySelector("[data-testid='background-task-kind']")
						?.textContent?.trim() ?? "",
				opens:
					node
						.querySelector("[data-testid='background-task-open']")
						?.getAttribute("aria-label") ?? null,
				selected: node.getAttribute("aria-current") === "true",
			})),
		),
		drawer: (await drawer.isVisible())
			? {
					selected: (
						await page.getByTestId("task-drawer-selected").innerText()
					).replace(/\s+/g, " "),
					transcript: (
						await page.getByTestId("task-drawer-transcript").innerText()
					).slice(0, 2000),
				}
			: null,
		focused: await page.evaluate(() => {
			const active = document.activeElement;
			return active
				? (active.getAttribute("data-testid") ??
						active.getAttribute("aria-label") ??
						active.tagName)
				: null;
		}),
	};
}

function recorder(page: Page, testInfo: TestInfo) {
	const report: {
		step: string;
		state: Awaited<ReturnType<typeof readState>>;
	}[] = [];
	return {
		async record(step: string) {
			const state = await readState(page);
			report.push({ step, state });
			const path = testInfo.outputPath(`${step}.png`);
			await page.screenshot({ path, animations: "disabled" });
			await testInfo.attach(`${step}.png`, { path, contentType: "image/png" });
			return state;
		},
		async write(name: string) {
			const path = testInfo.outputPath(name);
			writeFileSync(path, JSON.stringify({ report }, null, 2));
			await testInfo.attach(name, { path, contentType: "application/json" });
		},
	};
}

/** Finished turns fold their steps; open every log so each row renders. */
async function unfoldSteps(page: Page) {
	const folded = page.locator(
		'.turn-activity-toggle[aria-expanded="false"]:visible',
	);
	while ((await folded.count()) > 0) await folded.first().click();
}

test.describe("Claude task drill-in", () => {
	test.use({ claudeReplay: replay });

	test("on desktop a task opens in a live drawer and closing it leaves the parent unchanged", async ({
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
		const tasksRow = page.getByRole("button", {
			name: /^\d+ background tasks?$/,
		});
		const panel = page.getByTestId("background-tasks-panel");
		const drawer = page.getByTestId("task-drawer");
		const selected = page.getByTestId("task-drawer-selected");
		const transcript = page.getByTestId("task-drawer-transcript");
		const reply = transcript
			.locator(".msg-assistant")
			.filter({ hasText: AGENT_A_REPLY });
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
			await expect(tasksRow).toHaveAccessibleName("5 background tasks");
			await page.setViewportSize({ width: 1440, height: 350 });
			await unfoldSteps(page);
			const launchingShell = page
				.locator(".tool-item[data-launch-state]")
				.filter({ hasNot: page.locator(".subagent-link") })
				.first();
			await expect(launchingShell).toBeVisible();
			await launchingShell.locator("button").first().click({ force: true });
			await expect(launchingShell.locator(".shell-detail")).toHaveCount(0);
			await expect(drawer).toHaveCount(0);

			// The pull-down: agents open their tasks, shells only read.
			await tasksRow.click();
			await expect(panel).toBeVisible();
			const listed = await steps.record("pulldown");
			const agents = listed.rows.filter((row) => row.kind === "subagent");
			const shells = listed.rows.filter((row) => row.kind === "shell");
			expect(agents).toHaveLength(2);
			expect(shells).toHaveLength(3);
			for (const agent of agents)
				expect(agent.opens).toBe(`Open ${agent.description}`);
			for (const shell of shells)
				expect(shell.opens, `${shell.description} offers to open`).toBeNull();
			// Tapping a shell does nothing.
			const url = page.url();
			await panel
				.getByTestId("background-task")
				.filter({ has: page.getByText("shell", { exact: true }) })
				.first()
				.click();
			await expect(panel).toBeVisible();
			await expect(drawer).toHaveCount(0);
			expect(page.url()).toBe(url);

			// Open agent A: the drawer, beside the parent, never instead of it.
			const parentTranscript = page.locator("#messages");
			expect(
				await parentTranscript.evaluate(
					(node) => node.scrollHeight - node.clientHeight,
				),
			).toBeGreaterThan(60);
			await parentTranscript.evaluate((node) => {
				node.scrollTop = 60;
			});
			await expect
				.poll(() => parentTranscript.evaluate((node) => node.scrollTop))
				.toBe(60);
			const before = await readState(page);
			await panel.getByRole("button", { name: "Open agent A" }).click();
			await expect(drawer).toBeVisible();
			await expect(drawer).toBeFocused();
			await expect(panel).toBeHidden();
			await expect(selected).toHaveText(/agent A\s*·\s*subagent\s*·\s*running/);
			await expect(transcript).not.toHaveText(/^\s*$/);
			await expect(transcript).not.toContainText("Loading transcript");
			await expect(reply).toHaveCount(0);
			const opened = await steps.record("drawer-open");
			expect(opened.url).toBe(before.url);
			expect(
				opened.rows.filter((row) => row.selected).map((row) => row.description),
			).toEqual(["agent A"]);

			// Escape closes it: same session, same scroll, focus back on the row.
			await page.keyboard.press("Escape");
			await expect(drawer).toHaveCount(0);
			await expect(tasksRow).toBeFocused();
			const closed = await steps.record("drawer-closed");
			expect(closed.url).toBe(before.url);
			expect(closed.parentScrollTop).toBe(before.parentScrollTop);

			// Crossing the phone breakpoint discards the desktop drawer selection.
			await tasksRow.click();
			await panel.getByRole("button", { name: "Open agent A" }).click();
			await expect(drawer).toBeVisible();
			await page.setViewportSize({ width: 393, height: 852 });
			await expect(drawer).toHaveCount(0);
			expect(new URL(page.url()).pathname).toBe(before.url);
			await page.setViewportSize({ width: 1440, height: 900 });
			await expect(drawer).toHaveCount(0);
			await steps.record("back-from-phone-breakpoint");

			// Drawer selection is transient; a reload restores the parent session.
			await tasksRow.click();
			await panel.getByRole("button", { name: "Open agent A" }).click();
			await expect(drawer).toBeVisible();
			await page.reload();
			await expect(tasksRow).toBeVisible();
			await expect(drawer).toHaveCount(0);
			expect(new URL(page.url()).pathname).toBe(before.url);
			await steps.record("reload-with-drawer-open");

			// The launching row opens the same task; the drawer stays live as
			// agent A replies and finishes.
			await unfoldSteps(page);
			const launchButton = page
				.locator(`.tool-item[data-tool-id="${AGENT_A_TOOL}"] button`)
				.first();
			await launchButton.click();
			await expect(drawer).toBeVisible();
			await expect(selected).toContainText("agent A");
			replayer.release();
			await expect(reply).toBeVisible({ timeout: 30_000 });
			await expect(selected).toHaveText(/agent A\s*·\s*ended/, {
				timeout: 30_000,
			});
			const live = await steps.record("drawer-live");
			expect(live.url).toBe(before.url);

			// The close button returns focus to the launching row.
			await page.getByTestId("task-drawer-close").click();
			await expect(drawer).toHaveCount(0);
			await expect(launchButton).toBeFocused();
			await steps.record("drawer-closed-from-row");
		} finally {
			await steps.write("task-drill-in-desktop-report.json");
		}
	});

	test("on a phone a task opens full screen and back returns to where it was opened", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 393, height: 852 });
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const replayer = harness.claudeReplayer;
		if (!replayer) throw new Error("no Claude replayer");
		const steps = recorder(page, testInfo);
		const tasksRow = page.getByRole("button", {
			name: /^\d+ background tasks?$/,
		});
		const panel = page.getByTestId("background-tasks-panel");
		const launchRow = page.locator(
			`.tool-item[data-tool-id="${AGENT_A_TOOL}"]`,
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
			const parent = new URL(page.url()).pathname;

			// From the pull-down: the Child Session fills the screen; back
			// reopens the pull-down.
			await tasksRow.click();
			await panel.getByRole("button", { name: "Open agent A" }).click();
			await expect(page).not.toHaveURL(new RegExp(`${parent}$`));
			await expect(chat.subagentBackBtn).toBeVisible();
			await expect(page.getByTestId("task-drawer")).toHaveCount(0);
			const child = await steps.record("child-from-pulldown");
			expect(child.url).not.toBe(parent);
			await chat.subagentBackBtn.click();
			await expect(page).toHaveURL(new RegExp(`${parent}$`));
			await expect(panel).toBeVisible();
			await expect(tasksRow).toHaveAttribute("aria-expanded", "true");
			await steps.record("back-to-pulldown");
			await tasksRow.click();
			await expect(panel).toBeHidden();

			// From a launching row: back lands on that row, not the bottom.
			await unfoldSteps(page);
			const launchLink = launchRow.locator(".subagent-link");
			const target = await launchLink.boundingBox();
			expect(target?.width, "launch arrow width").toBeGreaterThanOrEqual(24);
			expect(target?.height, "launch arrow height").toBeGreaterThanOrEqual(24);
			await launchLink.focus();
			await page.keyboard.press("Enter");
			await expect(chat.subagentBackBtn).toBeVisible();
			expect(new URL(page.url()).pathname).toBe(child.url);
			await steps.record("child-from-launching-row");
			await chat.subagentBackBtn.click();
			await expect(page).toHaveURL(new RegExp(`${parent}$`));
			await expect(launchRow).toBeInViewport();
			await expect(panel).toBeHidden();
			await steps.record("back-to-launching-row");
			await launchRow.locator("button").first().focus();
			await page.keyboard.press("Enter");
			await expect(chat.subagentBackBtn).toBeVisible();
			expect(new URL(page.url()).pathname).toBe(child.url);
			await chat.subagentBackBtn.click();
			await expect(page).toHaveURL(new RegExp(`${parent}$`));
			await expect(launchRow).toBeInViewport();
			await steps.record("back-from-primary-launching-row");
		} finally {
			await steps.write("task-drill-in-phone-report.json");
		}
	});
});
