import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const PARENT_TITLE = "Stabilise visual suite";
const NEW_SIDE_THREAD = "sess-side-new";

// Newest first, as the list shows them. Ages are against the frozen clock.
const SIDE_THREADS = [
	{
		id: "sess-side-reply",
		title: "Which visual baseline is stale?",
		attention: "needs-reply",
		pendingQuestionCount: 1,
		age: 2 * 60,
	},
	{
		id: "sess-side-unread",
		title: "Why did the Linux gate skip?",
		attention: "done-unread",
		unread: true,
		age: 14 * 60,
	},
	{
		id: "sess-side-idle",
		title: "Is the island chevron still 44px?",
		age: 3 * 60 * 60,
	},
] as const;

const sessionIdOf = (url: string): string => {
	const sessionId = new URL(url).pathname.split("/")[2];
	if (!sessionId) throw new Error("Side Threads require an open session");
	return sessionId;
};

const parentIds = new WeakMap<Page, string>();

function requireParentId(page: Page): string {
	const id = parentIds.get(page);
	if (!id) throw new Error("Seed the session's Side Threads first");
	return id;
}

/** Replace the shell with the parent and its Side Threads, as the relay pushes them. */
async function setSideThreads(
	page: Page,
	sideThreads: readonly Record<string, unknown>[],
): Promise<void> {
	const now = await page.evaluate(() => Date.now());
	const rpc = requireRpcControl(page);
	const id = parentIds.get(page) ?? sessionIdOf(page.url());
	parentIds.set(page, id);
	const parent = rpc.shellRows?.find(
		(candidate) => (candidate as { id?: string }).id === id,
	);
	rpc.setShellRows([
		{
			id,
			status: "idle",
			messageCount: 6,
			...(parent as object | undefined),
			title: PARENT_TITLE,
			updatedAt: now,
		},
		...sideThreads.map(({ age, ...row }) => ({
			status: "idle",
			messageCount: 2,
			...row,
			parentID: id,
			sideThread: true,
			updatedAt: now - Number(age ?? 0) * 1000,
		})),
	]);
}

const sideThreadsPanel = (page: Page) => page.getByTestId("side-threads-panel");

export const sideThreadsHandlers: StepHandler[] = [
	{
		name: "seed Side Threads",
		match: /^the session has ([0-3]) Side Threads$/,
		run: async ({ world, match }) => {
			await setSideThreads(world.page, SIDE_THREADS.slice(0, Number(match[1])));
			await expect(world.page.getByTestId("session-bar")).toContainText(
				PARENT_TITLE,
			);
		},
	},
	{
		name: "answer Side Thread requests",
		match: /^the relay answers Side Thread requests$/,
		run: async ({ world }) => {
			requireRpcControl(world.page).setResponse("StartSideThread", {
				sessionId: NEW_SIDE_THREAD,
			});
		},
	},
	{
		name: "assert Side Thread started",
		match: /^a Side Thread titled (.+) is started from the session$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "StartSideThread",
			);
			expect(request.payload).toMatchObject({
				parentSessionId: requireParentId(world.page),
				title: match[1],
			});
			await expect(world.page).toHaveURL(
				new RegExp(`/s/${NEW_SIDE_THREAD}(?:\\?|$)`),
			);
			// The relay's family push: the new row joins the shell.
			await setSideThreads(world.page, [
				{ id: NEW_SIDE_THREAD, title: match[1], age: 0 },
			]);
		},
	},
	{
		name: "assert Side Thread message",
		match: /^the Side Thread receives the sent text (.+)$/,
		run: async ({ world, match }) => {
			await requireRpcControl(world.page).waitForRequest(
				(candidate) =>
					candidate.tag === "input.submit" &&
					candidate.payload["sessionId"] === NEW_SIDE_THREAD &&
					candidate.payload["text"] === match[1],
			);
		},
	},
	{
		name: "assert back bar",
		match: /^the back bar reads (Side Thread of .+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator(".subagent-back-bar")).toContainText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert header control",
		match:
			/^the header shows ([0-9]+) Side Threads with waiting and unread markers$/,
		run: async ({ world, match }) => {
			const control = world.page.getByTestId("side-threads-control");
			await expect(control).toHaveAccessibleName(`${match[1]} Side Threads`);
			await expect(control.getByTestId("side-threads-waiting")).toBeVisible();
			await expect(
				control.getByTestId("side-threads-unread-dot"),
			).toBeVisible();
		},
	},
	{
		name: "click Side Threads control",
		match: /^I click the Side Threads control$/,
		run: async ({ world }) => {
			const control = world.page.getByTestId("side-threads-control");
			await control.click();
			await expect(control).toHaveAttribute("aria-expanded", "true");
			await expect(sideThreadsPanel(world.page)).toBeVisible();
		},
	},
	{
		name: "assert listed Side Threads",
		match: /^the Side Threads list shows (.+)$/,
		run: async ({ world, match }) => {
			const rows = sideThreadsPanel(world.page).getByTestId("side-thread");
			await expect(rows.getByTestId("side-thread-title")).toHaveText(
				(match[1] ?? "").split(", "),
			);
			await expect(rows.getByTestId("side-thread-time")).toHaveText([
				"2m ago",
				"14m ago",
				"3h ago",
			]);
			await expect(
				rows.nth(0).getByTestId("side-thread-waiting"),
			).toBeVisible();
			await expect(
				rows.nth(1).getByTestId("side-thread-unread-dot"),
			).toBeVisible();
			await expect(rows.nth(2).getByTestId("side-thread-waiting")).toHaveCount(
				0,
			);
			await expect(
				rows.nth(2).getByTestId("side-thread-unread-dot"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert empty Side Threads list",
		match: /^the Side Threads list is empty$/,
		run: async ({ world }) => {
			await expect(
				sideThreadsPanel(world.page).getByTestId("side-threads-empty"),
			).toHaveText("No Side Threads yet. Type $btw and a question to ask one.");
			await expect(world.page.getByTestId("side-threads-control")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "assert list position",
		match: /^the Side Threads list hangs under the header on screen$/,
		run: async ({ world }) => {
			const viewport = world.page.viewportSize();
			const bar = await world.page.getByTestId("session-bar").boundingBox();
			const panel = await sideThreadsPanel(world.page).boundingBox();
			if (!viewport || !bar || !panel)
				throw new Error("Side Threads list is not laid out");
			expect(panel.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
			expect(panel.x).toBeGreaterThanOrEqual(0);
			expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width);
			expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height);
		},
	},
	{
		name: "assert empty composer",
		match: /^the composer is empty$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#input")).toHaveValue("");
		},
	},
	{
		name: "assert no Side Thread started",
		match: /^no Side Thread was started$/,
		run: async ({ world }) => {
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.some((request) => request.tag === "StartSideThread"),
			).toBe(false);
			await expect(world.page).toHaveURL(
				new RegExp(`/s/${requireParentId(world.page)}(?:\\?|$)`),
			);
		},
	},
	{
		name: "dismiss list with Escape",
		match: /^I press Escape in the Side Threads list$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "assert closed list",
		match: /^the Side Threads list is closed$/,
		run: async ({ world }) => {
			await expect(sideThreadsPanel(world.page)).toHaveCount(0);
			await expect(world.page.getByTestId("side-threads-scrim")).toHaveCount(0);
		},
	},
	{
		name: "open a listed Side Thread",
		match: /^I open the Side Thread titled (.+)$/,
		run: async ({ world, match }) => {
			const thread = SIDE_THREADS.find((row) => row.title === match[1]);
			if (!thread) throw new Error(`Unknown Side Thread: ${match[1]}`);
			await sideThreadsPanel(world.page)
				.getByTestId("side-thread")
				.filter({ hasText: thread.title })
				.getByTestId("side-thread-open")
				.click();
			await expect(world.page).toHaveURL(
				new RegExp(`/s/${thread.id}(?:\\?|$)`),
			);
		},
	},
	{
		name: "assert hidden control",
		match: /^the Side Threads control is hidden$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("side-threads-control")).toHaveCount(
				0,
			);
		},
	},
];
