import { expect, type Page } from "@playwright/test";
import type {
	ProjectInfo,
	SessionInfo,
} from "../../../src/lib/shared-types.js";
import {
	chooseSettingsOption,
	closeSettings,
} from "../../../test/e2e/helpers/settings.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Atlas is the mockup's attached project, so the fixture never removes it,
 *  which would reset the route. The others' slugs are their titles, lowercased. */
const slugOf = (title: string) =>
	title === "Atlas" ? "myapp" : title.toLowerCase();
const titles = (list: string) => list.split(",").map((title) => title.trim());

const sortValues: Record<string, string> = {
	"Last user message": "recent",
	Created: "created",
	Manual: "manual",
};

const header = (page: Page, title: string) =>
	page.locator(
		`[data-testid="project-tree-header"][data-project="${slugOf(title)}"]`,
	);
const rows = (page: Page, title: string) =>
	page.locator(`#project-tree-rows-${slugOf(title)}`);
/** A menu item closes under the pointer, which would leave a row hovered. */
const restPointer = (page: Page) =>
	page.mouse.move((page.viewportSize()?.width ?? 1) - 1, 1);

function row(
	slug: string,
	index: number,
	title: string,
	at: number,
): SessionInfo {
	return {
		accountId: null,
		id: `${slug}-${index}`,
		title,
		status: "idle",
		projectSlug: slug,
		updatedAt: at,
		lastUserMessageAt: at,
	};
}

export const projectTreeHandlers: StepHandler[] = [
	{
		name: "seed the project tree fixture",
		match: /^the sidebar has the project tree fixture$/,
		run: ({ world }) => {
			const projects: ProjectInfo[] = [
				{
					slug: "myapp",
					title: "Atlas",
					folders: ["/myapp"],
					addedAt: PINNED_CLOCK_MS - 30 * DAY,
				},
				{
					slug: "beacon",
					title: "Beacon",
					folders: ["/beacon"],
					addedAt: PINNED_CLOCK_MS - 10 * DAY,
				},
				{
					slug: "comet",
					title: "Comet",
					folders: ["/comet"],
					addedAt: PINNED_CLOCK_MS - 5 * DAY,
				},
				{
					slug: "delta",
					title: "Delta",
					folders: ["/delta"],
					addedAt: PINNED_CLOCK_MS - 20 * DAY,
				},
			];
			const sessions: SessionInfo[] = [
				...Array.from({ length: 8 }, (_, i) =>
					row(
						"myapp",
						i + 1,
						`Atlas session ${i + 1}`,
						PINNED_CLOCK_MS - (i + 1) * 5 * MINUTE,
					),
				),
				row("beacon", 1, "Beacon session 1", PINNED_CLOCK_MS - 120 * MINUTE),
				row("beacon", 2, "Beacon session 2", PINNED_CLOCK_MS - DAY),
				row("comet", 1, "Comet session 1", PINNED_CLOCK_MS - 3 * DAY),
			];
			const rpc = requireRpcControl(world.page);
			rpc.setProjects({ projects, projectOrder: ["delta", "comet"] });
			rpc.setStubs({
				ListDaemonSessions: ({ scope }) => ({
					sessions: sessions.filter(
						(session) => !scope || session.projectSlug === scope,
					),
					availability: [],
					hasMore: false,
					nextCursor: null,
				}),
				// The daemon persists the order and echoes it on the shell feed.
				SetProjectOrder: ({ projectOrder }) => {
					rpc.setProjects({ ...rpc.projectsFrame(), projectOrder });
					return undefined;
				},
			});
			rpc.setShellRows(sessions);
		},
	},
	{
		name: "group the session list by project",
		match: /^I group the sessions by project$/,
		run: async ({ world }) => {
			const { page } = world;
			await page.getByTestId("session-group-button").click();
			await page.getByTestId("session-group-option-project").click();
			await expect(page).toHaveURL(/[?&]group=project/);
			await restPointer(page);
			await expect(
				page.getByTestId("project-tree-header").first(),
			).toBeVisible();
		},
	},
	{
		name: "sort the project tree",
		match: /^I sort projects by (.+)$/,
		run: async ({ world, match }) => {
			const sort = sortValues[match[1] ?? ""];
			if (!sort) throw new Error(`Unknown project sort: ${match[1] ?? ""}`);
			const { page } = world;
			await page.getByTestId("session-group-button").click();
			const option = page.getByTestId(`project-sort-option-${sort}`);
			await option.click();
			await expect(option).toBeHidden();
			await restPointer(page);
		},
	},
	{
		name: "project tree order",
		match: /^the project tree lists (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("project-tree-title")).toHaveText(
				titles(match[1] ?? ""),
			);
		},
	},
	{
		name: "reload the project tree",
		match: /^I reload the project tree$/,
		run: async ({ world }) => {
			const { page } = world;
			await page.reload();
			await page.locator("#connect-overlay").waitFor({ state: "hidden" });
			await expect(
				page.getByTestId("project-tree-header").first(),
			).toBeVisible();
		},
	},
	{
		name: "project row count",
		match: /^the (\w+) project shows (\d+) sessions$/,
		run: async ({ world, match }) => {
			await expect(
				rows(world.page, match[1] ?? "").locator(".session-item"),
			).toHaveCount(Number(match[2]));
		},
	},
	{
		name: "project empty row",
		match: /^the (\w+) project shows the empty row$/,
		run: async ({ world, match }) => {
			await expect(
				rows(world.page, match[1] ?? "").getByTestId("project-tree-empty"),
			).toHaveText("No sessions");
		},
	},
	{
		// Manual sort adds a handle column; it must not shift a project's header
		// away from the sessions listed under it.
		name: "project title lines up with its sessions",
		match: /^the (\w+) project title lines up with its session titles$/,
		run: async ({ world, match }) => {
			const title = match[1] ?? "";
			const [project, session] = await Promise.all([
				header(world.page, title)
					.getByTestId("project-tree-title")
					.boundingBox(),
				rows(world.page, title)
					.locator(".session-title-inner")
					.first()
					.boundingBox(),
			]);
			if (!project || !session) throw new Error(`${title} is not laid out`);
			expect(Math.abs(project.x - session.x)).toBeLessThanOrEqual(3);
		},
	},
	{
		// A real pointer drag on the handle, released once the lifted project's
		// centre is above the target's: the list swaps at that midpoint.
		name: "drag a project above another",
		match: /^I drag the (\w+) project above the (\w+) project$/,
		run: async ({ world, match }) => {
			const { page } = world;
			const item = (title: string) =>
				page.getByTestId("sortable-row").filter({ has: header(page, title) });
			const moved = item(match[1] ?? "");
			const [handle, from, to] = await Promise.all([
				moved.getByTestId("sortable-handle").boundingBox(),
				moved.boundingBox(),
				item(match[2] ?? "").boundingBox(),
			]);
			if (!handle || !from || !to)
				throw new Error("The projects are not laid out");
			const x = handle.x + handle.width / 2;
			const y = handle.y + handle.height / 2;
			const grab = y - from.y;
			await page.mouse.move(x, y);
			await page.mouse.down();
			await page.mouse.move(
				x,
				to.y + to.height / 2 + grab - from.height / 2 - 4,
				{ steps: 12 },
			);
			await page.mouse.up();
			await restPointer(page);
		},
	},
	{
		name: "daemon saves the project order",
		match: /^the daemon saves the project order (.+)$/,
		run: async ({ world, match }) => {
			const expected = JSON.stringify(titles(match[1] ?? "").map(slugOf));
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SetProjectOrder" &&
					JSON.stringify(request.payload["projectOrder"]) === expected,
			);
		},
	},
	{
		name: "collapse a project",
		match: /^I collapse the (\w+) project$/,
		run: async ({ world, match }) => {
			const toggle = header(world.page, match[1] ?? "").getByTestId(
				"project-tree-toggle",
			);
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
			await toggle.click();
		},
	},
	{
		name: "project is collapsed",
		match: /^the (\w+) project is collapsed with (\d+) sessions shown$/,
		run: async ({ world, match }) => {
			const title = match[1] ?? "";
			await expect(
				header(world.page, title).getByTestId("project-tree-toggle"),
			).toHaveAttribute("aria-expanded", "false");
			await expect(
				rows(world.page, title).locator(".session-item"),
			).toHaveCount(Number(match[2]));
		},
	},
	{
		name: "project is expanded",
		match: /^the (\w+) project is expanded$/,
		run: async ({ world, match }) => {
			await expect(
				header(world.page, match[1] ?? "").getByTestId("project-tree-toggle"),
			).toHaveAttribute("aria-expanded", "true");
		},
	},
	{
		name: "show more or less in a project",
		match: /^I show (more|less) in the (\w+) project$/,
		run: async ({ world, match }) => {
			const toggle = rows(world.page, match[2] ?? "").getByTestId(
				"project-tree-more",
			);
			await expect(toggle).toHaveText(`Show ${match[1] ?? ""}`);
			await toggle.click();
		},
	},
	{
		name: "open a session from the project tree",
		match: /^I open the "([^"]+)" session from the project tree$/,
		run: async ({ world, match }) => {
			const { page } = world;
			// The row's hover actions sit over the middle of its title.
			await page
				.locator("#session-list .session-item-title", {
					hasText: match[1] ?? "",
				})
				.click({ position: { x: 8, y: 6 } });
			await expect(page).toHaveURL(/\/s\/[^?]+\?(.+&)?group=project/);
		},
	},
	{
		name: "project shows a session",
		match: /^the (\w+) project shows the "([^"]+)" session$/,
		run: async ({ world, match }) => {
			await expect(
				rows(world.page, match[1] ?? "").locator(".session-item-title", {
					hasText: match[2] ?? "",
				}),
			).toBeVisible();
		},
	},
	{
		name: "set sessions per project",
		match: /^I set Sessions per project to (\d+) in settings$/,
		run: async ({ world, match }) => {
			const { page } = world;
			await page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", { detail: { section: "general" } }),
				),
			);
			await chooseSettingsOption(
				page,
				page.getByTestId("settings-project-tree-rows"),
				match[1] ?? "",
			);
			await closeSettings(page);
			await expect(page.locator("#settings-panel")).toBeHidden();
		},
	},
	{
		name: "project Show more toggle presence",
		match: /^the (\w+) project (has|has no) a Show more toggle$/,
		run: async ({ world, match }) => {
			const toggle = rows(world.page, match[1] ?? "").getByTestId(
				"project-tree-more",
			);
			if (match[2] === "has") await expect(toggle).toHaveText("Show more");
			else await expect(toggle).toHaveCount(0);
		},
	},
	{
		name: "start a session from a project header",
		match: /^I start a new session in the (\w+) project$/,
		run: async ({ world, match }) => {
			const projectHeader = header(world.page, match[1] ?? "");
			// The desktop button appears on hover, in place of the count.
			await projectHeader.hover();
			await projectHeader.getByTestId("project-tree-new-session").click();
		},
	},
	{
		name: "draft opens in a project",
		match: /^a draft opens in the ([a-z0-9-]+) project$/,
		run: async ({ world, match }) => {
			await expect(world.page).toHaveURL(
				new RegExp(`/draft/[^/?]+\\?(.+&)?project=${match[1] ?? ""}(&|$)`),
			);
		},
	},
];
