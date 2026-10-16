import { expect } from "@playwright/test";
import { PROVIDER_SESSION_CAPABILITIES } from "../../../src/lib/contracts/provider-instance.js";
import type { StepHandler } from "../runtime.js";
import {
	mockInstances,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

// Oldest first, as the relay sends them. Ages are against the frozen clock.
const TASKS = [
	{
		id: "b1",
		type: "local_bash",
		description: "Start the Vite dev server",
		age: 6 * 60,
		kind: "shell",
		ageText: "6m",
		detail: "pnpm dev",
	},
	{
		id: "b2",
		type: "local_bash",
		description: "Run vitest in watch mode",
		age: 2 * 60,
		kind: "shell",
		ageText: "2m",
		detail: "pnpm vitest --watch",
	},
	{
		id: "a1",
		type: "local_agent",
		description: "Explore route guard usage",
		age: 40,
		childSessionId: "claude-subagent-explore",
		kind: "subagent",
		ageText: "40s",
		detail: "Explore",
	},
	{
		id: "w1",
		type: "local_workflow",
		description: "Review the router refactor",
		age: 12,
		kind: "workflow",
		ageText: "12s",
		detail: "review workflow",
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
	detail?: string;
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
	rpc.setDaemonList("SubscribeInstances", {
		instances: mockInstances.get(page) ?? [],
		providerCapabilities: PROVIDER_SESSION_CAPABILITIES,
	});
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
								detail,
							}) => ({
								id,
								type,
								description,
								firstSeenAt: now - age * 1000,
								...(parentTaskId ? { parentTaskId } : {}),
								...(childSessionId ? { childSessionId } : {}),
								...(detail ? { detail } : {}),
							}),
						)
					: undefined,
		},
	]);
}

export const backgroundTasksHandlers: StepHandler[] = [
	{
		name: "stop the composer turn with tasks",
		match: /^I stop the composer turn$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const id = sessionIdOf(world.page.url());
			rpc.setStubs({ CancelSession: () => ({ ok: true }) });
			setSessionRowStatus(world.page, id, "busy");
			await world.page.locator("#stop").click();
			await rpc.waitForRequest(
				(request) =>
					request.tag === "CancelSession" &&
					request.payload["sessionId"] === id,
			);
			setSessionRowStatus(world.page, id, "idle");
			await expect(world.page.locator("#stop")).toBeHidden();
		},
	},
	{
		name: "assert turn-stopped task toast",
		match: /^the turn-stopped toast says (.+)$/,
		run: async ({ world, match }) => {
			const toast = world.page
				.getByTestId("toast")
				.filter({ hasText: "Turn stopped." });
			await expect(toast).toContainText(match[1] ?? "");
			await expect(
				toast.getByRole("button", { name: "Stop them", exact: true }),
			).toBeVisible();
			await expect
				.poll(async () => {
					const bounds = await toast.boundingBox();
					const composer = await world.page
						.locator("#input-area")
						.boundingBox();
					if (!bounds || !composer)
						throw new Error("Missing toast or composer bounds");
					return bounds.y + bounds.height - composer.y;
				})
				.toBeLessThanOrEqual(0);
		},
	},
	{
		name: "assert turn-stopped toast absent",
		match: /^the turn-stopped toast is gone$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("toast").filter({ hasText: "Turn stopped." }),
			).toHaveCount(0);
		},
	},
	{
		name: "stop tasks from composer toast",
		match: /^I press Stop them in the turn-stopped toast$/,
		run: async ({ world }) => {
			requireRpcControl(world.page).setStubs({
				StopBackgroundTask: () => ({ ok: true }),
			});
			await world.page
				.getByTestId("toast")
				.getByRole("button", { name: "Stop them", exact: true })
				.click();
		},
	},
	{
		name: "assert composer task stop requests",
		match: /^the toast asks to stop (.+) without another session cancellation$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter((request) => request.tag === "StopBackgroundTask")
						.map((request) => request.payload["taskId"]),
				)
				.toEqual((match[1] ?? "").split(", "));
			const stops = rpc
				.getRequests()
				.filter((request) => request.tag === "StopBackgroundTask");
			for (const stop of stops)
				expect(stop.payload["sessionId"]).toBe(sessionIdOf(world.page.url()));
			expect(
				rpc.getRequests().filter((request) => request.tag === "CancelSession"),
			).toHaveLength(1);
		},
	},
	{
		name: "seed live background tasks",
		match: /^the session has ([1-4]) live background tasks?$/,
		run: async ({ world, match }) => {
			await setLiveTasks(
				world.page,
				TASKS.slice(0, Number(match[1])).map(
					({ detail: _detail, ...task }) => task,
				),
			);
			await expect(
				world.page.getByTestId("background-tasks-row"),
			).toBeVisible();
		},
	},
	{
		name: "seed launcher details",
		match: /^the background task launcher details are available$/,
		run: async ({ world }) => {
			await setLiveTasks(world.page, TASKS);
		},
	},
	{
		name: "assert launcher details",
		match:
			/^the background tasks pull-down shows each command or agent under its description$/,
		run: async ({ world }) => {
			const items = world.page
				.getByTestId("background-tasks-panel")
				.getByTestId("background-task");
			await expect(items.getByTestId("background-task-detail")).toHaveText(
				TASKS.map((task) => task.detail),
			);
			for (const [i, task] of TASKS.entries())
				await expect(
					items.nth(i).getByTestId("background-task-detail"),
				).toHaveAttribute("title", task.detail);
		},
	},
	{
		name: "assert kind fallback",
		match:
			/^the background tasks pull-down shows only kinds for unjoinable tasks$/,
		run: async ({ world }) => {
			const items = world.page
				.getByTestId("background-tasks-panel")
				.getByTestId("background-task");
			await expect(items.getByTestId("background-task-kind")).toHaveText([
				"shell",
				"shell",
			]);
			await expect(items.getByTestId("background-task-detail")).toHaveCount(0);
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
		name: "assert task-specific stop controls",
		match:
			/^the background tasks pull-down offers a named stop control for each task$/,
		run: async ({ world }) => {
			for (const task of TASKS)
				await expect(
					world.page.getByRole("button", {
						name: `Stop ${task.description}`,
						exact: true,
					}),
				).toBeVisible();
		},
	},
	{
		name: "stop a named background task",
		match: /^I stop the background task (.+)$/,
		run: async ({ world, match }) => {
			requireRpcControl(world.page).setStubs({
				StopBackgroundTask: () => ({ ok: true }),
			});
			await world.page
				.getByRole("button", { name: `Stop ${match[1]}`, exact: true })
				.click();
		},
	},
	{
		name: "SDK confirms vitest stopped",
		match: /^the SDK reports the vitest task stopped$/,
		run: async ({ world }) => {
			await setLiveTasks(world.page, TASKS.slice(0, 1));
		},
	},
	{
		name: "hide stop controls for unsupported providers",
		match: /^the background tasks pull-down has no stop controls$/,
		run: async ({ world }) => {
			const panel = world.page.getByTestId("background-tasks-panel");
			await expect(panel).toBeVisible();
			await expect(panel.getByRole("button", { name: /^Stop / })).toHaveCount(
				0,
			);
		},
	},
	{
		name: "press Stop all",
		match: /^I press Stop all in the background tasks pull-down$/,
		run: async ({ world }) => {
			requireRpcControl(world.page).setStubs({
				StopBackgroundTask: () => ({ ok: true }),
			});
			await world.page.getByTestId("background-tasks-stop-all").click();
		},
	},
	{
		name: "assert task stops leave the session and rows intact",
		match:
			/^the background tasks pull-down asks to stop (.+) without cancelling the session$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const ids = (match[1] ?? "").split(", ");
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter((request) => request.tag === "StopBackgroundTask")
						.map((request) => request.payload["taskId"]),
				)
				.toEqual(ids);
			for (const request of rpc
				.getRequests()
				.filter((request) => request.tag === "StopBackgroundTask"))
				expect(request.payload["sessionId"]).toBe(
					sessionIdOf(world.page.url()),
				);
			expect(
				rpc.getRequests().some((request) => request.tag === "CancelSession"),
			).toBe(false);
			await expect(
				world.page.getByTestId("background-tasks-panel"),
			).toBeVisible();
		},
	},
];
