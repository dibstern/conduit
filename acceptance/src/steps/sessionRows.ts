import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import type {
	ProjectInfo,
	SessionInfo,
} from "../../../src/lib/shared-types.js";
import {
	freezeAnimations,
	screenshotLocator,
	waitForIcons,
} from "../../../test/e2e/helpers/visual-helpers.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const OPENCODE_ROW_ID = "row-opencode";

export const sessionRowsHandlers: StepHandler[] = [
	{
		name: "seed textless Draft sidebar counts",
		match:
			/^the sidebar has a textless Draft with (\d+) images and (\d+) files$/,
		run: async ({ world, match }) => {
			const rows = [
				{
					draftId: "draft-label",
					projectSlug: "myapp",
					firstLine: "",
					updatedAt: PINNED_CLOCK_MS,
					imageCount: Number(match[1]),
					fileCount: Number(match[2]),
				},
			];
			const rpc = requireRpcControl(world.page);
			await expect.poll(() => rpc.hasStream("SubscribeDrafts")).toBe(true);
			rpc.sendChunk("SubscribeDrafts", [rows]);
			if (!(await world.page.locator("#session-list").isVisible()))
				await world.page.getByTestId("session-bar-back").click();
		},
	},
	{
		name: "textless Draft sidebar label",
		match: /^the Draft sidebar label is (.+) with a paperclip$/,
		run: async ({ world, match }) => {
			const row = world.page.locator('[data-draft-id="draft-label"]');
			await expect(row.locator("[title]")).toHaveAttribute(
				"title",
				match[1] ?? "",
			);
			await expect(row.getByTestId("draft-attachment-icon")).toBeVisible();
		},
	},
	{
		name: "seed session groups",
		match: /^the sidebar has the session group fixture$/,
		run: async ({ world }) => {
			const rows: SessionInfo[] = (
				["pinned", "running", "idle"] as const
			).flatMap((group) =>
				Array.from({ length: 3 }, (_, i) => ({
					id: `${group}-${i}`,
					accountId: null,
					projectSlug: "myapp",
					title: `${group} task ${i + 1}`,
					status: group === "running" ? "busy" : "idle",
					attention: group === "running" ? "working" : "idle",
					...(group === "pinned" ? { pinnedAt: PINNED_CLOCK_MS } : {}),
				})),
			);
			const rpc = requireRpcControl(world.page);
			rpc.setShellRows(rows);
			rpc.setStubs({
				ListDaemonSessions: () => ({
					sessions: rows,
					availability: [],
					hasMore: false,
					nextCursor: null,
				}),
			});
			const list = world.page.locator("#session-list");
			if (!(await list.isVisible()))
				await world.page.getByTestId("session-bar-back").click();
			await expect(list).toBeVisible();
		},
	},
	{
		name: "toggle a session group",
		match: /^I (collapse|expand) the (pinned|running|idle) session group$/,
		run: async ({ world, match }) => {
			const toggle = world.page.getByTestId(`${match[2]}-shelf-toggle`);
			await expect(toggle).toHaveAttribute(
				"aria-expanded",
				String(match[1] === "collapse"),
			);
			await toggle.click();
		},
	},
	{
		name: "session group visibility",
		match:
			/^the (pinned|running|idle) session group is (collapsed|expanded) with (\d+) rows$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`${match[1]}-shelf-toggle`),
			).toHaveAttribute("aria-expanded", String(match[2] === "expanded"));
			await expect(
				world.page.locator(`#${match[1]}-shelf-rows .session-item`),
			).toHaveCount(Number(match[3]));
		},
	},
	{
		name: "reload session group preferences",
		match: /^I reload the session group list$/,
		run: async ({ world }) => {
			await world.page.reload();
			await expect(world.page.locator("#layout")).toBeVisible();
			if (!(await world.page.locator("#session-list").isVisible()))
				await world.page.getByTestId("session-bar-back").click();
		},
	},
	{
		name: "seed worktree and Local session rows",
		match:
			/^the sidebar has an existing worktree on (.+), a new worktree on (.+) and a Local session on (.+)$/,
		run: ({ world, match }) => {
			const rows: SessionInfo[] = [
				{
					accountId: null,
					id: "row-existing",
					title: "Existing worktree",
					status: "idle",
					projectSlug: "myapp",
					updatedAt: PINNED_CLOCK_MS - 60_000,
					workspace: {
						cause: "user",
						origin: "existing",
						worktrees: { "/myapp": "/worktrees/existing" },
					},
					git: { branch: match[1] ?? "", worktree: "existing", merged: false },
				},
				{
					accountId: null,
					id: "row-new",
					title: "New worktree",
					status: "idle",
					projectSlug: "myapp",
					updatedAt: PINNED_CLOCK_MS - 120_000,
					workspace: {
						cause: "launch",
						origin: "conduit",
						worktrees: { "/myapp": "/worktrees/new" },
					},
					git: { branch: match[2] ?? "", worktree: "new", merged: false },
				},
				{
					accountId: null,
					id: "row-local",
					title: "Local session",
					status: "idle",
					projectSlug: "myapp",
					updatedAt: PINNED_CLOCK_MS - 180_000,
					// A project's primary folder can itself be a linked checkout.
					git: { branch: match[3] ?? "", worktree: "primary", merged: false },
				},
			];
			requireRpcControl(world.page).setShellRows(rows);
		},
	},
	{
		name: "seed separate project session rows",
		match:
			/^the sidebar has sessions in two projects for a shared repository and one project for a lone repository$/,
		run: ({ world }) => {
			const projects: ProjectInfo[] = [
				{
					slug: "myapp",
					title: "Checkout one",
					folders: ["/myapp"],
					repositoryIdentities: {
						"/myapp": {
							key: "example.test/team/shared",
							name: "Shared",
							root: "/myapp",
						},
					},
				},
				{
					slug: "checkout-two",
					title: "Checkout two",
					folders: ["/workspaces/shared-two"],
					repositoryIdentities: {
						"/workspaces/shared-two": {
							key: "example.test/team/shared",
							name: "Shared",
							root: "/workspaces/shared-two",
						},
					},
				},
				{
					slug: "solo",
					title: "Solo checkout",
					folders: ["/workspaces/solo"],
					repositoryIdentities: {
						"/workspaces/solo": {
							key: "example.test/team/solo",
							name: "Solo",
							root: "/workspaces/solo",
						},
					},
				},
			];
			const rows: SessionInfo[] = [
				{
					accountId: null,
					id: "row-project-one",
					title: "First project session",
					status: "idle",
					projectSlug: "myapp",
					updatedAt: PINNED_CLOCK_MS - 60_000,
					git: { branch: "main" },
				},
				{
					accountId: null,
					id: "row-project-two",
					title: "Second project session",
					status: "idle",
					projectSlug: "checkout-two",
					updatedAt: PINNED_CLOCK_MS - 120_000,
					git: { branch: "main" },
				},
				{
					accountId: null,
					id: "row-solo",
					title: "Lone repository session",
					status: "idle",
					projectSlug: "solo",
					updatedAt: PINNED_CLOCK_MS - 180_000,
					git: { branch: "main" },
				},
			];
			const rpc = requireRpcControl(world.page);
			rpc.setProjects({ projects });
			rpc.setStubs({
				ListDaemonSessions: ({ scope }) => ({
					sessions: rows.filter((row) => !scope || row.projectSlug === scope),
					availability: [],
					hasMore: false,
					nextCursor: null,
				}),
			});
			rpc.setShellRows(rows);
		},
	},
	{
		name: "seed an OpenCode session row",
		match: /^the sidebar has an OpenCode session titled "([^"]+)"$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).setShellRows([
				{
					accountId: "opencode",
					id: OPENCODE_ROW_ID,
					title: match[1] ?? "",
					status: "idle",
					projectSlug: "myapp",
					updatedAt: PINNED_CLOCK_MS - 60_000,
					// A non-Claude model provider is what marks the row as OpenCode.
					model: { model: "gpt-5.1", provider: "openai" },
				} satisfies SessionInfo,
			]);
		},
	},
	{
		// session.renamed has no relay message: committing it re-projects the
		// session, and the shell stream upserts the row with its new title.
		name: "rename the OpenCode session from the server",
		match: /^the server renames the OpenCode session to "([^"]+)"$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const row = rpc.shellRows?.find(
				(candidate) => (candidate as SessionInfo).id === OPENCODE_ROW_ID,
			);
			if (!row) throw new Error("The OpenCode session row was not seeded");
			rpc.upsertShellRow({
				...(row as SessionInfo),
				title: match[1] ?? "",
			});
		},
	},
	{
		name: "OpenCode session row title",
		match: /^the OpenCode session row shows the title "([^"]+)"$/,
		run: async ({ world, match }) => {
			const title = world.page
				.locator(`#session-list [data-session-id="${OPENCODE_ROW_ID}"]`)
				.locator(".session-title-inner");
			await expect(title).toHaveText(match[1] ?? "");
			// Let a rename's one-shot gleam end so the baseline holds the settled row.
			await expect(title).not.toHaveClass(/session-title-gleam/);
		},
	},
	{
		name: "select All projects in the session list",
		match: /^I select All projects in the session list$/,
		run: async ({ world }) => {
			await world.page.getByTestId("session-scope-chip").click();
			await world.page
				.getByRole("menuitemradio", { name: "All projects", exact: true })
				.click();
			await expect(world.page.getByTestId("session-scope-chip")).toHaveText(
				"All projects",
			);
		},
	},
	{
		name: "session row project and branch label",
		match: /^the "([^"]+)" session row shows "([^"]+)" and branch "([^"]+)"$/,
		run: async ({ world, match }) => {
			const row = world.page.locator("#session-list .session-item").filter({
				has: world.page.locator(".session-item-title", {
					hasText: match[1] ?? "",
				}),
			});
			await expect(
				row.locator(".session-item-context > span").last(),
			).toHaveText(match[2] ?? "");
			await expect(row.locator(".session-item-context > code")).toHaveText(
				match[3] ?? "",
			);
			await expect(row).toHaveAccessibleName(
				new RegExp((match[3] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
		},
	},
	{
		name: "Local session row has no branch label",
		match: /^the "([^"]+)" session row shows only "([^"]+)" with no branch$/,
		run: async ({ world, match }) => {
			const row = world.page.locator("#session-list .session-item").filter({
				has: world.page.locator(".session-item-title", {
					hasText: match[1] ?? "",
				}),
			});
			await expect(
				row.locator(".session-item-context > span").last(),
			).toHaveText(match[2] ?? "");
			await expect(row.locator(".session-item-context > code")).toHaveCount(0);
		},
	},
	{
		name: "save repository session row screenshot",
		match: /^the session list grouping screenshot is saved as ([a-z0-9-]+)$/,
		run: async ({ world, match }) => {
			await waitForIcons(world.page);
			await freezeAnimations(world.page);
			const screenshot = await screenshotLocator(
				world.page.locator("#session-list"),
			);
			const directory = resolve("acceptance/visual/artifacts");
			await mkdir(directory, { recursive: true });
			const path = resolve(directory, `${match[1]}.png`);
			await writeFile(path, screenshot);
			world.artifacts.push(path);
			console.log(`ARTIFACT ${path}`);
		},
	},
];
