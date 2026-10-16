import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple", screenshot: "off" });

// The words composer keeps the checkout in the footer on phones too.
test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			"conduit-composer-preferences",
			JSON.stringify({ controls: "words" }),
		);
	});
});

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
]) {
	test(`removed worktree notice at ${viewport.width}px clears on the next move`, async ({
		page,
		harness,
	}, testInfo) => {
		await page.setViewportSize(viewport);
		const projectSlug = "e2e-replay";
		const main = "/workspace/main";
		const projects = [
			{ slug: projectSlug, title: "Workspace project", folders: [main] },
		];
		const session = {
			accountId: null,
			id: "moved-back-session",
			title: "Removed worktree",
			status: "idle" as const,
			projectSlug,
			provider: "claude",
			git: { branch: "main" },
			workspace: {
				cause: "missing" as const,
				origin: "existing" as const,
				worktrees: {},
			},
		};
		const rpc = await mockWsRpc(page, {
			stubs: {
				ListDaemonSessions: () => ({
					sessions: [session],
					availability: [],
					hasMore: false,
					nextCursor: null,
				}),
				GetModels: ({ projectSlug }) => ({
					defaultOpenCodeInstanceId: "opencode",
					projectSlug,
					providers: [],
				}),
			},
			handlers: {
				GetProjects: () => ({ projects, current: projectSlug }),
			},
		});
		rpc.setShellRows([session]);
		rpc.setFamilyRows([session]);
		await mockRelayWebSocket(page, {
			initMessages: [
				{ type: "project_list", projects, current: projectSlug },
				{ type: "shell_snapshot", roots: true, sessions: [session] },
			],
			responses: new Map(),
		});
		await page.goto(`${harness.relayBaseUrl}/s/${session.id}`);
		const identity = page.getByTestId("composer-checkout");
		const notice = page.getByTestId("workspace-moved-back");
		await expect(notice).toBeVisible();
		await expect(notice).toHaveAttribute("role", "img");
		await expect(notice).toHaveAttribute(
			"aria-label",
			"moved back: worktree removed",
		);
		await expect(notice).toHaveText("");
		await expect(identity).toHaveAccessibleName(/moved back: worktree removed/);
		await page.screenshot({
			path: testInfo.outputPath("workspace-moved-back.png"),
		});
		// A shell row carrying a later workspace change clears the notice.
		rpc.upsertShellRow({
			...session,
			workspace: {
				cause: "user" as const,
				origin: "existing" as const,
				worktrees: { [main]: "/workspace/next-worktree" },
			},
			git: { branch: "next", worktree: "next-worktree" },
		});
		await expect(notice).toHaveCount(0);
		await expect(identity).toContainText("next-worktree");
		// Main-folder resets arrive as null or an omitted workspace field.
		// RPC JSON omits undefined; the family row still carries cause missing.
		for (const workspace of [null, undefined]) {
			rpc.upsertShellRow(session);
			await expect(notice).toBeVisible();
			rpc.upsertShellRow({ ...session, workspace });
			await expect(notice).toHaveCount(0);
			await expect(identity).toHaveAccessibleName("Checkout: main / main");
		}
	});
}
