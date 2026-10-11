import { expect } from "@playwright/test";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
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
];
