import { expect, type Page } from "@playwright/test";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { type LiveTask, setLiveTasks } from "./backgroundTasks.js";
import { FLAKY_TEST_SESSION, rowOf } from "./launchingRows.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

const sessionIdOf = (page: Page): string => {
	const sessionId = new URL(page.url()).pathname.split("/")[2];
	if (!sessionId) throw new Error("Task drill-in requires an open session");
	return sessionId;
};

/** The parent each scenario drills in from, kept once the URL moves to a child. */
const parents = new WeakMap<Page, string>();
const parentOf = (page: Page): string => {
	const parent = parents.get(page);
	if (!parent) throw new Error("No parent session was recorded");
	return parent;
};

const CHILD_PROMPT = "Find why the router test is flaky and fix it";
const CHILD_REPLY =
	"The guard test races the route loader; re-running it to confirm.";
const started = PINNED_CLOCK_MS - 42_000;

/** Upsert one shell row, keeping the rest of the snapshot. */
function upsertRow(page: Page, row: { id: string } & Record<string, unknown>) {
	const rpc = requireRpcControl(page);
	const rows = rpc.shellRows ?? [];
	const held = rows.find(
		(candidate) => (candidate as { id?: string }).id === row.id,
	);
	rpc.setShellRows([
		...rows.filter((candidate) => candidate !== held),
		{ ...(held as object | undefined), ...row },
	]);
}

// Agents with Child Sessions and shells without, more than the list can show.
const OVERFLOW_TASKS: LiveTask[] = Array.from({ length: 10 }, (_, index) =>
	index % 2 === 0
		? {
				id: `agent-${index}`,
				type: "local_agent",
				description: `Investigate the intermittent failure in the checkout flow, part ${index / 2 + 1}`,
				age: 30 * (12 - index),
				childSessionId: `claude-subagent-overflow-${index}`,
			}
		: {
				id: `shell-${index}`,
				type: "local_bash",
				description: `pnpm vitest run --reporter=verbose test/checkout/part-${index}.test.ts`,
				age: 30 * (12 - index),
			},
);

const drawer = (page: Page) => page.getByTestId("task-drawer");
const panel = (page: Page) => page.getByTestId("background-tasks-panel");

export const taskDrillInHandlers: StepHandler[] = [
	{
		name: "assert the task drill-in fixture clock",
		match: /^the task drill-in clock matches its fixture time$/,
		run: async ({ world }) => {
			expect(
				await world.page.evaluate(() => ({
					now: Date.now(),
					date: new Date().toISOString(),
				})),
			).toEqual({
				now: PINNED_CLOCK_MS,
				date: new Date(PINNED_CLOCK_MS).toISOString(),
			});
		},
	},
	{
		name: "seed the flaky-test agent's Child Session",
		match:
			/^the flaky-test agent's Child Session is part way through its work$/,
		run: async ({ world }) => {
			const parent = sessionIdOf(world.page);
			parents.set(world.page, parent);
			upsertRow(world.page, {
				id: FLAKY_TEST_SESSION,
				parentID: parent,
				title: "Fix the flaky test",
				status: "busy",
				messageCount: 2,
				updatedAt: PINNED_CLOCK_MS,
			});
			requireRelayControl(world.page).sendMessage({
				type: "mock_transcript_snapshot",
				sessionId: FLAKY_TEST_SESSION,
				history: {
					hasMore: false,
					messages: [
						{
							id: "msg-child-user",
							role: "user",
							time: { created: started },
							parts: [
								{ id: "part-child-user", type: "text", text: CHILD_PROMPT },
							],
						},
						{
							id: "msg-child-agent",
							role: "assistant",
							parentID: "msg-child-user",
							time: { created: started + 1 },
							parts: [
								{
									id: "part-child-read",
									type: "tool",
									tool: "Read",
									callID: "call-child-read",
									state: {
										status: "completed",
										input: { file_path: "test/router/guard.test.ts" },
										output: "describe('route guard', ...)",
									},
									time: { start: started + 1000, end: started + 1500 },
								},
								{
									id: "part-child-text",
									type: "text",
									text: CHILD_REPLY,
								},
								{
									id: "part-child-bash",
									type: "tool",
									tool: "Bash",
									callID: "call-child-bash",
									state: {
										status: "running",
										input: {
											command: "pnpm test test/router",
											description: "Run the router tests",
										},
									},
									time: { start: started + 2000 },
								},
							],
						},
					],
				},
			});
		},
	},
	{
		name: "seed an overflowing task list",
		match: /^the session has 10 live background tasks with long descriptions$/,
		run: async ({ world }) => {
			await setLiveTasks(world.page, OVERFLOW_TASKS);
			await expect(
				world.page.getByTestId("background-tasks-row"),
			).toBeVisible();
		},
	},
	{
		name: "finish every task and the Child Session",
		match: /^every background task finishes$/,
		run: ({ world }) => {
			upsertRow(world.page, {
				id: parentOf(world.page),
				// undefined drops out of the JSON snapshot, clearing the tasks.
				backgroundWork: undefined,
				backgroundTasks: undefined,
			});
			upsertRow(world.page, { id: FLAKY_TEST_SESSION, status: "idle" });
		},
	},
	{
		name: "open a task from the pull-down",
		match: /^I open "(.+)" from the background tasks pull-down$/,
		run: async ({ world, match }) => {
			parents.set(world.page, sessionIdOf(world.page));
			await panel(world.page)
				.getByRole("button", { name: `Open ${match[1]}` })
				.click();
		},
	},
	{
		name: "open a launching row's task",
		match: /^I open the "(.+)" launching row's task$/,
		run: async ({ world, match }) => {
			parents.set(world.page, sessionIdOf(world.page));
			await rowOf(world.page, match[1] ?? "")
				.locator(".subagent-link")
				.click();
		},
	},
	{
		name: "assert the pull-down's agents open and its shells only read",
		match:
			/^the pull-down's agent rows open their tasks and its shell rows only read$/,
		run: async ({ world }) => {
			const items = panel(world.page).getByTestId("background-task");
			await expect(items.first()).toBeVisible();
			const rows = await items.evaluateAll((nodes) =>
				nodes.map((node) => ({
					kind: node.querySelector("[data-testid='background-task-kind']")
						?.textContent,
					opens:
						node.querySelector("[data-testid='background-task-open']") !== null,
					label:
						node
							.querySelector("[data-testid='background-task-open']")
							?.getAttribute("aria-label") ?? null,
					description: node.querySelector(
						"[data-testid='background-task-description']",
					)?.textContent,
				})),
			);
			for (const row of rows) {
				expect(row.opens).toBe(row.kind !== "shell");
				if (row.opens) expect(row.label).toBe(`Open ${row.description}`);
			}
			// Tapping a shell does nothing: the pull-down stays and no task opens.
			const url = world.page.url();
			await items
				.filter({ has: world.page.getByText("shell", { exact: true }) })
				.first()
				.click();
			await expect(panel(world.page)).toBeVisible();
			await expect(drawer(world.page)).toHaveCount(0);
			expect(world.page.url()).toBe(url);
		},
	},
	{
		name: "assert the drawer shows the task's Child Session",
		match: /^the task drawer shows "(.+)" with its Child Session transcript$/,
		run: async ({ world, match }) => {
			await expect(drawer(world.page)).toBeVisible();
			await expect(drawer(world.page)).toBeFocused();
			await expect(
				world.page.getByTestId("task-drawer-selected"),
			).toContainText(match[1] ?? "");
			const transcript = world.page.getByTestId("task-drawer-transcript");
			await expect(transcript).toContainText(CHILD_PROMPT);
			await expect(transcript).toContainText(CHILD_REPLY);
			// Beside the parent, not instead of it.
			expect(sessionIdOf(world.page)).toBe(parentOf(world.page));
			await expect(world.page.locator("#messages")).not.toContainText(
				CHILD_REPLY,
			);
			await expect(
				drawer(world.page).locator(
					"[data-testid='background-task'][aria-current='true']",
				),
			).toContainText(match[1] ?? "");
		},
	},
	{
		name: "assert the drawer keeps an ended task",
		match: /^the task drawer says "(.+)" ended and still shows its transcript$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("task-drawer-selected")).toHaveText(
				new RegExp(`${match[1]}\\s*· ended`),
			);
			await expect(
				drawer(world.page).getByTestId("background-tasks-list"),
			).toHaveCount(0);
			// A finished turn folds its mid-turn notes into the activity log.
			await expect(
				world.page.getByTestId("task-drawer-transcript"),
			).toContainText(CHILD_PROMPT);
		},
	},
	{
		name: "close the drawer with Escape",
		match: /^I press Escape in the task drawer$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "assert the drawer closed back to its opener",
		match:
			/^the task drawer is closed and focus is back on (the background tasks row|the launching row)$/,
		run: async ({ world, match }) => {
			await expect(drawer(world.page)).toHaveCount(0);
			expect(sessionIdOf(world.page)).toBe(parentOf(world.page));
			await expect(
				match[1] === "the background tasks row"
					? world.page.locator(
							'[data-testid="background-tasks-toggle"], button[data-testid="background-tasks-row"]',
						)
					: rowOf(world.page, "Fix the flaky test").locator(".subagent-link"),
			).toBeFocused();
		},
	},
	{
		name: "assert the phone child view",
		match: /^the flaky-test agent's Child Session fills the screen$/,
		run: async ({ world }) => {
			await expect(world.page).toHaveURL(
				new RegExp(`/s/${FLAKY_TEST_SESSION}(?:\\?|$)`),
			);
			await expect(world.page.locator("#messages")).toContainText(CHILD_REPLY);
			await expect(world.page.locator(".subagent-back-btn")).toBeVisible();
			await expect(drawer(world.page)).toHaveCount(0);
		},
	},
	{
		name: "go back from the child view",
		match: /^I go back to the parent session$/,
		run: async ({ world }) => {
			await world.page.locator(".subagent-back-btn").click();
			await expect(world.page).toHaveURL(
				new RegExp(`/s/${parentOf(world.page)}(?:\\?|$)`),
			);
		},
	},
	{
		name: "assert the pull-down reopened",
		match: /^the background tasks pull-down is open again$/,
		run: async ({ world }) => {
			await expect(panel(world.page)).toBeVisible();
			await expect(
				world.page.getByTestId("background-tasks-row"),
			).toHaveAttribute("aria-expanded", "true");
		},
	},
	{
		name: "assert the launching row is back in view",
		match: /^the "(.+)" launching row is back in view$/,
		run: async ({ world, match }) => {
			await expect(rowOf(world.page, match[1] ?? "")).toBeInViewport();
			await expect(panel(world.page)).toHaveCount(0);
		},
	},
];
