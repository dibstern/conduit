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

export const sessionRowsHandlers: StepHandler[] = [
	{
		name: "seed worktree and Local session rows",
		match:
			/^the sidebar has an existing worktree on (.+), a new worktree on (.+) and a Local session on (.+)$/,
		run: ({ world, match }) => {
			const rows: SessionInfo[] = [
				{
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
		name: "seed grouped repository session rows",
		match:
			/^the sidebar has sessions in two projects for a shared repository and one project for a lone repository$/,
		run: ({ world }) => {
			const projects: ProjectInfo[] = [
				{
					slug: "myapp",
					title: "Checkout one",
					folders: ["/myapp"],
					groupingMode: "repository",
					effectiveGroupingMode: "repository",
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
					groupingMode: "repository",
					effectiveGroupingMode: "repository",
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
					groupingMode: "repository",
					effectiveGroupingMode: "repository",
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
					id: "row-grouped-one",
					title: "First grouped session",
					status: "idle",
					projectSlug: "myapp",
					updatedAt: PINNED_CLOCK_MS - 60_000,
					git: { branch: "main" },
				},
				{
					id: "row-grouped-two",
					title: "Second grouped session",
					status: "idle",
					projectSlug: "checkout-two",
					updatedAt: PINNED_CLOCK_MS - 120_000,
					git: { branch: "main" },
				},
				{
					id: "row-solo",
					title: "Lone repository session",
					status: "idle",
					projectSlug: "solo",
					updatedAt: PINNED_CLOCK_MS - 180_000,
					git: { branch: "main" },
				},
			];
			const rpc = requireRpcControl(world.page);
			rpc.setResponse("GetProjects", { projects, current: "myapp" });
			rpc.setDaemonList("SubscribeProjects", { projects, current: "myapp" });
			rpc.setHandler("ListDaemonSessions", ({ scope, exclude }) => ({
				sessions: rows.filter(
					(row) =>
						row.projectSlug !== exclude &&
						(!scope || row.projectSlug === scope),
				),
				availability: [],
				hasMore: false,
				nextCursor: null,
			}));
			rpc.setShellRows(rows.filter((row) => row.projectSlug === "myapp"));
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
			).toHaveText(`${match[2]} · ${match[3]}`);
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
