import { expect } from "@playwright/test";
import { PROVIDER_SESSION_CAPABILITIES } from "../../../src/lib/contracts/provider-instance.js";
import type { StepHandler } from "../runtime.js";
import {
	mockInstances,
	requireRpcControl,
	setSessionRowStatus,
	settleTransitions,
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
		name: "assert a header drop-down's scrim covers the composer",
		match: /^the composer is covered by the drop-down's scrim$/,
		run: async ({ world }) => {
			await settleTransitions(world.page);
			// A scrim trapped in the header's stacking context paints under the composer, leaving it live.
			const hit = await world.page.evaluate(() => {
				const box = document
					.getElementById("input-area")
					?.getBoundingClientRect();
				if (!box) return "no composer";
				const target = document.elementFromPoint(
					box.left + box.width / 2,
					box.top + box.height / 2,
				);
				return target?.closest("#input-area")
					? `composer: ${target.outerHTML.slice(0, 120)}`
					: "covered";
			});
			expect(hit).toBe("covered");
		},
	},
	{
		name: "assert top task sheet geometry after opening or springing back",
		match: /^the task sheet rests below the phone header with scrim below it$/,
		run: async ({ world }) => {
			const panel = world.page.getByTestId("background-tasks-panel");
			const sheet = world.page
				.locator('[data-sheet-edge="top"]')
				.filter({ has: panel });
			await expect(panel).toBeVisible();
			await expect
				.poll(async () => {
					const header = await world.page.locator("#session-bar").boundingBox();
					const box = await sheet.boundingBox();
					return header && box
						? Math.abs(box.y - header.y - header.height)
						: Infinity;
				})
				.toBeLessThan(1);
			const box = await sheet.boundingBox();
			const scrim = world.page.getByTestId("background-tasks-scrim");
			const scrimBox = await scrim.boundingBox();
			const viewport = world.page.viewportSize();
			if (!box || !scrimBox || !viewport)
				throw new Error("Task sheet is not laid out");
			expect(box.x).toBe(0);
			expect(box.width).toBe(viewport.width);
			expect(viewport.height - box.y - box.height).toBeGreaterThanOrEqual(64);
			expect(Math.abs(scrimBox.y - box.y)).toBeLessThan(1);
			await expect(sheet.locator("[data-sheet-chrome]")).toHaveCSS(
				"border-bottom-left-radius",
				"22px",
			);
			await expect(sheet.locator("[data-sheet-chrome]")).toHaveCSS(
				"border-bottom-right-radius",
				"22px",
			);
			await expect(sheet.locator("[data-sheet-handle]")).toHaveCSS(
				"width",
				"36px",
			);
			await expect(sheet.locator("[data-sheet-handle]")).toHaveCSS(
				"height",
				"5px",
			);
		},
	},
	{
		name: "drag the task sheet with a native touch",
		match:
			/^I drag (inside the task sheet (?:down|up)|the task sheet up) by (\d+) pixels$/,
		run: async ({ world, match }) => {
			const panel = world.page.getByTestId("background-tasks-panel");
			const sheet = world.page
				.locator('[data-sheet-edge="top"]')
				.filter({ has: panel });
			const inside = match[1]?.startsWith("inside") ?? false;
			const target = sheet.locator(
				inside ? "[data-sheet-body]" : "[data-sheet-handle]",
			);
			const box = await target.boundingBox();
			if (!box) throw new Error("Task sheet touch target is missing");
			const restingY = (await sheet.boundingBox())?.y;
			if (restingY === undefined) throw new Error("Task sheet is missing");
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			const dy = Number(match[2]) * (match[1]?.endsWith("down") ? 1 : -1);
			const touch = await world.page.context().newCDPSession(world.page);
			try {
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [{ x, y }],
				});
				for (let step = 1; step <= 12; step++) {
					await touch.send("Input.dispatchTouchEvent", {
						type: "touchMove",
						touchPoints: [{ x, y: y + (dy * step) / 12 }],
					});
					// Keep a short pull below the shared flick threshold.
					await world.page.waitForTimeout(35);
				}
				const draggedY = (await sheet.boundingBox())?.y;
				if (draggedY === undefined)
					throw new Error("Task sheet vanished before release");
				if (inside) expect(Math.abs(draggedY - restingY)).toBeLessThan(1);
				else expect(draggedY).toBeLessThan(restingY - Math.abs(dy) * 0.8);
			} finally {
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
				await touch.detach();
			}
		},
	},
	{
		name: "assert the task body scrolled without dismissing its sheet",
		match: /^the task sheet body has scrolled$/,
		run: async ({ world }) => {
			await expect
				.poll(() =>
					world.page
						.locator('[data-sheet-edge="top"] [data-sheet-body]')
						.evaluate((node) => node.scrollTop),
				)
				.toBeGreaterThan(0);
		},
	},
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
		match:
			/^the session has ([1-4]) live background tasks?( with their commands)?$/,
		run: async ({ world, match }) => {
			const tasks = TASKS.slice(0, Number(match[1]));
			await setLiveTasks(
				world.page,
				match[2] ? tasks : tasks.map(({ detail: _detail, ...task }) => task),
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
		match:
			/^the background tasks row shows (.+) and (no more pill|\+[0-9]+|responsive overflow)$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("background-tasks-row");
			const chips = row.getByTestId("background-task-chip");
			if (/^\d+ background tasks?$/.test(match[1] ?? "")) {
				expect(match[2], "Phone task summaries have no overflow pill").toBe(
					"no more pill",
				);
				await expect(row.getByTestId("background-tasks-toggle")).toHaveText(
					match[1] ?? "",
				);
				await expect(
					row.getByTestId("background-tasks-row-stop-all"),
				).toBeVisible();
				await expect(chips).toHaveCount(0);
				await expect(row.getByTestId("background-tasks-more")).toHaveCount(0);
				return;
			}
			const expected = (match[1] ?? "")
				.split(", ")
				.map((label) => new RegExp(`^\\s*${label}`));
			const more = row.getByTestId("background-tasks-more");
			if (match[2] === "responsive overflow") {
				await expect(async () => {
					const visible = await chips.count();
					expect(visible).toBeGreaterThan(0);
					expect(visible).toBeLessThanOrEqual(expected.length);
					await expect(chips).toHaveText(expected.slice(0, visible), {
						timeout: 1_000,
					});
					const hidden = expected.length - visible;
					if (hidden > 0)
						await expect(more).toHaveText(`+${hidden}`, { timeout: 1_000 });
					else await expect(more).toHaveCount(0, { timeout: 1_000 });
				}).toPass({ timeout: 10_000 });
				return;
			}
			await expect(chips).toHaveText(expected);
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
		name: "assert no composer task dots",
		match: /^the composer shows no task dots$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("composer-task-dots")).toHaveCount(0);
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
			const toggle = (await row.getByTestId("background-tasks-toggle").count())
				? row.getByTestId("background-tasks-toggle")
				: row;
			await expect(toggle).toHaveRole("button");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
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
			const panel = world.page.getByTestId("background-tasks-panel");
			await expect(panel).toBeVisible();
			for (const task of TASKS)
				await expect(
					world.page.getByRole("button", {
						name: `Stop background task ${task.description}`,
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
				.getByRole("button", {
					name: `Stop background task ${match[1]}`,
					exact: true,
				})
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
		match: /^I press Stop all in the background tasks (pull-down|row)$/,
		run: async ({ world, match }) => {
			requireRpcControl(world.page).setStubs({
				StopBackgroundTask: () => ({ ok: true }),
			});
			await world.page
				.getByTestId(
					match[1] === "row"
						? "background-tasks-row-stop-all"
						: "background-tasks-stop-all",
				)
				.click();
		},
	},
	{
		name: "assert task stops leave the session and rows intact",
		match:
			/^the background tasks (pull-down|row) asks to stop (.+) without cancelling the session$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const ids = (match[2] ?? "").split(", ");
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
			const panel = world.page.getByTestId("background-tasks-panel");
			if (match[1] === "row") await expect(panel).toBeHidden();
			else await expect(panel).toBeVisible();
		},
	},
];
