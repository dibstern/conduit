/*
Failure modes:
- A missing isolated workspace is mistaken for the automatic moved-back state.
- The phone hides the missing state from assistive technology.
- Recovery sends a request for the wrong session or uses an ordinary workspace move.
- Recreate is offered after the branch has been deleted.
- A recovered shell row leaves the missing state from an older family row visible.
- Typed recreate and continue failures lose their specific toast message.
- Multi-folder notices omit the missing folder names, including on phones.
- A missing extra folder is labelled clean, or the healthy primary loses its status.
- One deleted folder branch still offers a partial Recreate action.
*/
import type { Page, TestInfo } from "@playwright/test";
import { WorkspaceMoveError } from "../../../src/lib/contracts/session-workspace.js";
import {
	type WorkspaceMissing,
	WorktreeRecoveryError,
} from "../../../src/lib/contracts/worktree.js";
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

const projectSlug = "e2e-replay";
const main = "/workspace/main";
const worktree = "/workspace/worktrees/missing-session/0";
const branch = "conduit/missing-session";

async function openMissingSession(
	page: Page,
	relayBaseUrl: string,
	workspaceMissing: WorkspaceMissing = {
		path: worktree,
		branch,
		canRecreate: true,
	},
	extraWorktrees: Readonly<Record<string, string>> = {},
) {
	const projects = [
		{
			slug: projectSlug,
			title: "Workspace project",
			folders: [main, ...Object.keys(extraWorktrees)],
		},
	];
	const session = {
		accountId: null,
		id: "missing-session",
		title: "Missing worktree",
		status: "idle",
		projectSlug,
		provider: "claude",
		workspace: {
			cause: "launch",
			origin: "conduit",
			worktrees: { [main]: worktree, ...extraWorktrees },
		},
		workspaceMissing,
	};
	const rpc = await mockWsRpc(page, {
		handlers: {
			GetModels: ({ projectSlug }) => ({ projectSlug, providers: [] }),
			GetProjects: () => ({ projects, current: projectSlug }),
			ListDaemonSessions: () => ({
				sessions: [session],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			RecreateSessionWorktree: () => ({ directory: worktree }),
			ContinueSessionInMainFolder: () => ({ directory: main }),
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
	await page.goto(`${relayBaseUrl}/s/${session.id}`);
	return { rpc, session };
}

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
]) {
	for (const missing of ["extra", "primary", "both"] as const) {
		test(`multi-folder ${missing} missing at ${viewport.width}px names folders and recreates`, async ({
			page,
			harness,
		}, testInfo) => {
			await page.setViewportSize(viewport);
			const extra = "/workspace/library";
			const extraPath = "/workspace/worktrees/missing-session/library";
			const entries = [
				{ folder: main, path: worktree, branch, canRecreate: true },
				{ folder: extra, path: extraPath, branch, canRecreate: true },
			].filter(
				({ folder }) =>
					missing === "both" ||
					(missing === "primary" ? folder === main : folder === extra),
			);
			const first = entries[0];
			if (!first) throw new Error("No missing folder in fixture");
			const { rpc, session } = await openMissingSession(
				page,
				harness.relayBaseUrl,
				{
					path: first.path,
					branch,
					canRecreate: true,
					folders: entries,
				},
				{ [extra]: extraPath },
			);
			rpc.upsertShellRow({
				...session,
				git: {
					...(missing === "extra"
						? { branch, worktree: "0", dirty: true }
						: {}),
					folders: [main, extra].map((root) => ({
						root,
						label: root === main ? "main" : "library",
						...(entries.some(({ folder }) => folder === root)
							? { missing: true }
							: { branch, worktree: "0", dirty: true }),
					})),
				},
			});
			const names = entries.map(({ folder }) =>
				folder === main ? "main" : "library",
			);
			const label = `worktree missing: ${names.join(", ")}`;
			const identity = page.getByTestId("composer-checkout");
			const notice = page.getByTestId("workspace-missing");
			await expect(notice).toBeVisible();
			await expect(notice).toHaveAttribute("aria-label", label);
			await expect(identity).toHaveAccessibleName(new RegExp(label));
			await capture(page, testInfo, "multi-folder-missing");
			await identity.click();
			const menu = page.getByRole("menu", { name: "Checkout" });
			for (const { folder, path } of entries) {
				await expect(
					menu
						.getByTestId("workspace-missing-folder")
						.filter({ hasText: path }),
				).toContainText(folder === main ? "main" : "library");
				const folderStatus = menu.locator(`[data-folder-root="${folder}"]`);
				await expect(folderStatus).toContainText("Worktree missing");
				await expect(folderStatus).not.toContainText("clean");
			}
			await capture(page, testInfo, "multi-folder-missing-menu");
			await menu.getByRole("menuitem", { name: "Recreate worktree" }).click();
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter(({ tag }) => tag === "RecreateSessionWorktree")
						.map(({ payload }) => payload),
				)
				.toEqual([
					{
						_tag: "RecreateSessionWorktree",
						projectSlug,
						sessionId: session.id,
					},
				]);
			rpc.upsertShellRow({
				...session,
				workspaceMissing: undefined,
				git: { branch, worktree: "0" },
			});
			await expect(notice).toHaveCount(0);
			await capture(page, testInfo, "multi-folder-recovered");
			await testInfo.attach("multi-folder-recovery-request", {
				body: JSON.stringify({
					missingFolders: entries,
					requests: rpc
						.getRequests()
						.filter(({ tag }) => tag === "RecreateSessionWorktree"),
				}),
				contentType: "application/json",
			});
		});
	}
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path, animations: "disabled" });
	await testInfo.attach(name, { path, contentType: "image/png" });
}

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
]) {
	for (const recovery of [
		{ tag: "RecreateSessionWorktree", label: "Recreate worktree" },
		{ tag: "ContinueSessionInMainFolder", label: "Continue in main folder" },
	]) {
		test(`missing worktree at ${viewport.width}px: ${recovery.label}`, async ({
			page,
			harness,
		}, testInfo) => {
			await page.setViewportSize(viewport);
			const { rpc, session } = await openMissingSession(
				page,
				harness.relayBaseUrl,
			);
			const identity = page.getByTestId("composer-checkout");
			const notice = page.getByTestId("workspace-missing");
			await expect(notice).toBeVisible();
			await expect(page.getByTestId("workspace-moved-back")).toHaveCount(0);
			await expect(notice).toHaveAttribute("role", "img");
			await expect(notice).toHaveAttribute("aria-label", "worktree missing");
			await expect(notice).toHaveText("");
			await expect(identity).toHaveAccessibleName(/worktree missing/);
			await capture(page, testInfo, "workspace-missing");
			await identity.click();
			const menu = page.getByRole("menu", { name: "Checkout" });
			await expect(menu).toContainText(worktree);
			await expect(
				menu.getByRole("menuitem", { name: "Recreate worktree" }),
			).toBeVisible();
			await expect(
				menu.getByRole("menuitem", { name: "Continue in main folder" }),
			).toBeVisible();
			await capture(page, testInfo, "workspace-missing-menu");
			await menu.getByRole("menuitem", { name: recovery.label }).click();
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter(({ tag }) => tag === recovery.tag)
						.map(({ payload }) => payload),
				)
				.toEqual([{ _tag: recovery.tag, projectSlug, sessionId: session.id }]);
			await expect(menu).not.toBeVisible();
			const recreated = recovery.tag === "RecreateSessionWorktree";
			rpc.upsertShellRow({
				...session,
				workspaceMissing: undefined,
				workspace: recreated ? session.workspace : null,
				git: recreated ? { branch, worktree: "0" } : { branch: "main" },
			});
			await expect(notice).toHaveCount(0);
			await expect(identity).toHaveAttribute(
				"title",
				recreated ? `0 / ${branch}` : "main / main",
			);
			await expect(page.getByTestId("workspace-moved-back")).toHaveCount(0);
			await identity.click();
			await expect(
				menu.getByRole("menuitem", { name: "Recreate worktree" }),
			).toHaveCount(0);
			await expect(
				menu.getByRole("menuitem", { name: "Continue in main folder" }),
			).toHaveCount(0);
			await testInfo.attach("workspace-recovery-request", {
				body: JSON.stringify({
					path: recreated ? worktree : main,
					request: rpc.getRequests().find(({ tag }) => tag === recovery.tag),
				}),
				contentType: "application/json",
			});
		});
	}
}

test("a deleted branch offers only Continue in main folder", async ({
	page,
	harness,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openMissingSession(page, harness.relayBaseUrl, {
		path: worktree,
		branch,
		canRecreate: false,
		reason: "branch-missing",
	});
	await page.getByTestId("composer-checkout").click();
	const menu = page.getByRole("menu", { name: "Checkout" });
	await expect(
		menu.getByRole("menuitem", { name: "Recreate worktree" }),
	).toHaveCount(0);
	await expect(
		menu.getByRole("menuitem", { name: "Continue in main folder" }),
	).toBeVisible();
	await expect(menu).toContainText("branch no longer exists");
	await capture(page, testInfo, "workspace-missing-branch-deleted");
});

for (const failure of [
	{
		tag: "RecreateSessionWorktree",
		label: "Recreate worktree",
		error: new WorktreeRecoveryError({
			path: worktree,
			reason: "branch-missing",
			message: "Could not recreate worktree: its branch no longer exists",
		}),
		toast: "Could not recreate worktree: its branch no longer exists",
	},
	{
		tag: "ContinueSessionInMainFolder",
		label: "Continue in main folder",
		error: new WorkspaceMoveError({ path: main, reason: "missing" }),
		toast: "Could not move session: that folder no longer exists",
	},
]) {
	test(`${failure.label} preserves a typed recovery error toast`, async ({
		page,
		harness,
	}, testInfo) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const { rpc } = await openMissingSession(page, harness.relayBaseUrl);
		rpc.setHandler(failure.tag, () => {
			throw failure.error;
		});
		await page.getByTestId("composer-checkout").click();
		await page.getByRole("menuitem", { name: failure.label }).click();
		await expect(page.getByRole("alert")).toContainText(failure.toast);
		await expect(page.getByTestId("workspace-missing")).toBeVisible();
		await capture(page, testInfo, "workspace-recovery-error");
	});
}
