import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

// Oldest first, as the relay sends them. Ages are against the frozen clock.
const TASKS = [
	{
		id: "b1",
		type: "local_bash",
		description: "Start the Vite dev server",
		age: 6 * 60,
		kind: "shell",
		ageText: "6m",
	},
	{
		id: "b2",
		type: "local_bash",
		description: "Run vitest in watch mode",
		age: 2 * 60,
		kind: "shell",
		ageText: "2m",
	},
	{
		id: "a1",
		type: "local_agent",
		description: "Explore route guard usage",
		age: 40,
		childSessionId: "claude-subagent-explore",
		kind: "subagent",
		ageText: "40s",
	},
	{
		id: "w1",
		type: "local_workflow",
		description: "Review the router refactor",
		age: 12,
		kind: "workflow",
		ageText: "12s",
	},
] as const;

// An agent that started two shells of its own, beside a shell of the parent's.
// The relay lists them in the order the SDK first reported them.
const NESTED_TASKS = [
	{
		id: "a1",
		type: "local_agent",
		description: "Fix the flaky router test",
		age: 5 * 60,
		childSessionId: "claude-subagent-flaky-router",
	},
	{
		id: "b1",
		type: "local_bash",
		description: "Start the Vite dev server",
		age: 4 * 60,
	},
	{
		id: "n1",
		type: "local_bash",
		description: "pnpm test --watch",
		age: 3 * 60,
		parentTaskId: "a1",
	},
	{
		id: "n2",
		type: "local_bash",
		description: "tail -f router.log",
		age: 90,
		parentTaskId: "a1",
	},
];

export type LiveTask = {
	id: string;
	type: string;
	description: string;
	age: number;
	parentTaskId?: string;
	childSessionId?: string;
};

const sessionIdOf = (url: string): string => {
	const sessionId = new URL(url).pathname.split("/")[2];
	if (!sessionId) throw new Error("Background tasks require an open session");
	return sessionId;
};

export async function setLiveTasks(
	page: import("@playwright/test").Page,
	tasks: readonly LiveTask[],
): Promise<void> {
	const now = await page.evaluate(() => Date.now());
	const rpc = requireRpcControl(page);
	const id = sessionIdOf(page.url());
	// Merge into the existing row: a row replaces the session's goal state too.
	const row = rpc.shellRows?.find(
		(candidate) => (candidate as { id?: string }).id === id,
	);
	rpc.setShellRows([
		{
			id,
			title: "Stabilise visual suite",
			status: "idle",
			messageCount: 6,
			...(row as object | undefined),
			updatedAt: now,
			// undefined drops out of the JSON snapshot, clearing earlier tasks.
			backgroundWork: tasks.length > 0 ? "working" : undefined,
			backgroundTasks:
				tasks.length > 0
					? tasks.map(
							({
								id,
								type,
								description,
								age,
								parentTaskId,
								childSessionId,
							}) => ({
								id,
								type,
								description,
								firstSeenAt: now - age * 1000,
								...(parentTaskId ? { parentTaskId } : {}),
								...(childSessionId ? { childSessionId } : {}),
							}),
						)
					: undefined,
		},
	]);
}

export const backgroundTasksHandlers: StepHandler[] = [
	{
		name: "seed live background tasks",
		match: /^the session has ([1-4]) live background tasks?$/,
		run: async ({ world, match }) => {
			await setLiveTasks(world.page, TASKS.slice(0, Number(match[1])));
			await expect(
				world.page.getByTestId("background-tasks-row"),
			).toBeVisible();
		},
	},
	{
		name: "seed an agent with nested tasks",
		match:
			/^the session's live background tasks are an agent with 2 nested shells and a shell$/,
		run: async ({ world }) => {
			await setLiveTasks(world.page, NESTED_TASKS);
			await expect(
				world.page.getByTestId("background-tasks-row"),
			).toBeVisible();
		},
	},
	{
		name: "end the last background task",
		match: /^the session's last background task ends$/,
		run: async ({ world }) => {
			await setLiveTasks(world.page, []);
		},
	},
	{
		name: "assert row chips and more pill",
		match: /^the background tasks row shows (.+) and (no more pill|\+[0-9]+)$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("background-tasks-row");
			await expect(row.getByTestId("background-task-chip")).toHaveText(
				(match[1] ?? "")
					.split(", ")
					.map((description) => new RegExp(`^\\s*${description}`)),
			);
			const more = row.getByTestId("background-tasks-more");
			if (match[2] === "no more pill") await expect(more).toHaveCount(0);
			else await expect(more).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "assert row elbow",
		match:
			/^the background tasks row (hangs off the goal with an elbow|has no elbow)$/,
		run: async ({ world, match }) => {
			const elbow = world.page.getByTestId("background-tasks-elbow");
			if (match[1] === "has no elbow") {
				await expect(elbow).toHaveCount(0);
				return;
			}
			await expect(elbow).toBeVisible();
			// The row sits directly under the goal subtitle.
			const goal = await world.page
				.getByTestId("session-goal-subtitle")
				.boundingBox();
			const row = await world.page
				.getByTestId("background-tasks-row")
				.boundingBox();
			expect(goal && row && row.y >= goal.y + goal.height - 1).toBe(true);
		},
	},
	{
		name: "assert composer task dots",
		match: /^the composer shows (no|[0-9]+) task dots$/,
		run: async ({ world, match }) => {
			const dots = world.page.getByTestId("composer-task-dots");
			if (match[1] === "no") await expect(dots).toHaveCount(0);
			else await expect(dots.locator("i")).toHaveCount(Number(match[1]));
		},
	},
	{
		name: "assert od8e banner removed",
		match: /^the old background work banner is gone$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("background-work-banner"),
			).toHaveCount(0);
		},
	},
	{
		name: "open background tasks pull-down",
		match: /^I click the background tasks row$/,
		run: async ({ world }) => {
			const row = world.page.getByTestId("background-tasks-row");
			await expect(row).toHaveRole("button");
			await row.click();
			await expect(row).toHaveAttribute("aria-expanded", "true");
		},
	},
	{
		name: "assert pull-down task list",
		match:
			/^the background tasks pull-down lists the 4 tasks with kinds and ages$/,
		run: async ({ world }) => {
			const panel = world.page.getByTestId("background-tasks-panel");
			await expect(panel).toBeVisible();
			await expect(panel).toContainText("4 background tasks");
			const items = panel.getByTestId("background-task");
			await expect(items.getByTestId("background-task-description")).toHaveText(
				TASKS.map((task) => task.description),
			);
			await expect(items.getByTestId("background-task-kind")).toHaveText(
				TASKS.map((task) => task.kind),
			);
			await expect(items.getByTestId("background-task-age")).toHaveText(
				TASKS.map((task) => task.ageText),
			);
		},
	},
	{
		name: "assert pull-down nesting",
		match:
			/^the background tasks pull-down lists the agent's 2 shells indented under it$/,
		run: async ({ world }) => {
			const panel = world.page.getByTestId("background-tasks-panel");
			await expect(panel).toContainText("4 background tasks");
			const items = panel.getByTestId("background-task");
			await expect(items.getByTestId("background-task-description")).toHaveText(
				[
					"Fix the flaky router test",
					"pnpm test --watch",
					"tail -f router.log",
					"Start the Vite dev server",
				],
			);
			await expect(items.getByTestId("background-task-kind")).toHaveText([
				"subagent",
				"shell",
				"shell",
				"shell",
			]);
			const depths = await items.evaluateAll((nodes) =>
				nodes.map((node) => node.getAttribute("data-depth")),
			);
			expect(depths).toEqual(["0", "1", "1", "0"]);
			const [agent, nested] = await Promise.all([
				items.nth(0).boundingBox(),
				items.nth(1).boundingBox(),
			]);
			expect(agent && nested && nested.x > agent.x).toBe(true);
		},
	},
	{
		name: "dismiss pull-down with Escape",
		match: /^I press Escape in the background tasks pull-down$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "assert closed pull-down",
		match: /^the background tasks pull-down is closed$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("background-tasks-panel"),
			).toBeHidden();
			await expect(
				world.page.getByTestId("background-tasks-scrim"),
			).toBeHidden();
		},
	},
	{
		name: "assert row gone",
		match: /^the background tasks row is gone$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("background-tasks-row")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "press Stop all",
		match: /^I press Stop all in the background tasks pull-down$/,
		run: async ({ world }) => {
			requireRpcControl(world.page).setResponse("CancelSession", { ok: true });
			await world.page.getByTestId("background-tasks-stop-all").click();
		},
	},
	{
		name: "assert Stop all cancels the session",
		match:
			/^the background tasks pull-down asks to cancel the current session$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const request = await rpc.waitForRequest(
				(candidate) => candidate.tag === "CancelSession",
			);
			expect(request.payload["sessionId"]).toBe(sessionIdOf(world.page.url()));
			await expect(
				world.page.getByTestId("background-tasks-panel"),
			).toBeHidden();
		},
	},
];
