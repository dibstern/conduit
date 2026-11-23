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
import { mockDaemonWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple", screenshot: "off" });

// Words keeps the checkout chip in the footer on both phone and desktop.
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
	appBaseUrl: string,
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
			folders: [main, ...Object.keys(extraWorktrees)] as const,
		},
	];
	const session = {
		accountId: null,
		id: "missing-session",
		title: "Missing worktree",
		status: "idle" as const,
		projectSlug,
		provider: "claude",
		workspace: {
			cause: "launch" as const,
			origin: "conduit" as const,
			worktrees: { [main]: worktree, ...extraWorktrees },
		},
		workspaceMissing,
	};
	const rpc = await mockWsRpc(page, {
		stubs: {
			RecreateSessionWorktree: () => ({ directory: worktree }),
			ContinueSessionInMainFolder: () => ({ directory: main }),
			ListDaemonSessions: () => ({
				sessions: [session],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			GetModels: (input) => ({
				projectSlug: "projectSlug" in input ? input.projectSlug : projectSlug,
				providers: [],
			}),
			GetProjects: () => ({ projects, current: projectSlug }),
		},
	});
	rpc.setShellRows([session]);
	rpc.setFamilyRows([session]);
	await mockDaemonWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: projectSlug },
			{ type: "shell_snapshot", roots: true, sessions: [session] },
		],
		responses: new Map(),
	});
	await page.goto(`${appBaseUrl}/s/${session.id}`);
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
				harness.appBaseUrl,
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
			const identity = page.locator(
				'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
			);
			const notice = page.locator(
				'[data-testid="workspace-notice-indicator"]:visible',
			);
			await expect(notice).toBeVisible();
			await expect(notice).toHaveAttribute("aria-label", label);
			await expect(identity).toHaveAccessibleName(new RegExp(label));
			await capture(page, testInfo, "multi-folder-missing");
			await identity.click();
			const menu = page.getByTestId("model-picker");
			await expect(page.getByTestId("picker-row-checkout")).toBeFocused();
			await expect(menu.getByTestId("picker-checkout-warning")).toHaveAttribute(
				"aria-label",
				label,
			);
			for (const { folder } of entries)
				await expect(menu.getByTestId("picker-checkout-notice")).toContainText(
					folder === main ? "main" : "library",
				);
			await menu.getByTestId("picker-row-checkout").click();
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
			await menu.getByTestId("picker-back").click();
			await capture(page, testInfo, "multi-folder-missing-menu");
			await menu.getByTestId("picker-checkout-notice-recreate").click();
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
						sessionId: session.id,
					},
				]);
			rpc.upsertShellRow({
				...session,
				workspaceMissing: undefined,
				git: { branch, worktree: "0" },
			});
			await expect(menu.getByTestId("picker-checkout-warning")).toHaveCount(0);
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
				harness.appBaseUrl,
			);
			const identity = page.locator(
				'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
			);
			const notice = page.locator(
				'[data-testid="workspace-notice-indicator"]:visible',
			);
			await expect(notice).toBeVisible();
			await expect(identity).not.toHaveAccessibleName(
				/moved back: worktree removed/,
			);
			await expect(notice).toHaveAttribute("role", "img");
			await expect(notice).toHaveAttribute("aria-label", "worktree missing");
			await expect(notice).toHaveText("");
			await expect(identity).toHaveAccessibleName(/worktree missing/);
			await capture(page, testInfo, "workspace-missing");
			await identity.click();
			const menu = page.getByTestId("model-picker");
			await expect(menu.getByTestId("picker-checkout-notice")).toContainText(
				"worktree missing",
			);
			await menu.getByTestId("picker-row-checkout").click();
			await expect(menu).toContainText(worktree);
			await menu.getByTestId("picker-back").click();
			const recreateAction = menu.getByTestId(
				"picker-checkout-notice-recreate",
			);
			const continueAction = menu.getByTestId(
				"picker-checkout-notice-continue",
			);
			await expect(recreateAction).toBeVisible();
			await expect(continueAction).toBeVisible();
			await capture(page, testInfo, "workspace-missing-menu");
			await (recovery.tag === "RecreateSessionWorktree"
				? recreateAction
				: continueAction
			).click();
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter(({ tag }) => tag === recovery.tag)
						.map(({ payload }) => payload),
				)
				.toEqual([{ _tag: recovery.tag, sessionId: session.id }]);
			await expect(menu).toBeVisible();
			const recreated = recovery.tag === "RecreateSessionWorktree";
			rpc.upsertShellRow({
				...session,
				workspaceMissing: undefined,
				workspace: recreated ? session.workspace : null,
				git: recreated ? { branch, worktree: "0" } : { branch: "main" },
			});
			await expect(menu.getByTestId("picker-checkout-warning")).toHaveCount(0);
			await expect(menu.getByTestId("picker-checkout-notice")).toHaveCount(0);
			await expect(notice).toHaveCount(0);
			await expect(identity).toHaveAttribute(
				"title",
				recreated ? `0 / ${branch}` : "main / main",
			);
			await expect(identity).not.toHaveAccessibleName(
				/moved back: worktree removed/,
			);
			await expect(recreateAction).toHaveCount(0);
			await expect(continueAction).toHaveCount(0);
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
	await openMissingSession(page, harness.appBaseUrl, {
		path: worktree,
		branch,
		canRecreate: false,
		reason: "branch-missing",
	});
	await page
		.locator(
			'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
		)
		.click();
	const menu = page.getByTestId("model-picker");
	await expect(menu.getByTestId("picker-checkout-notice-recreate")).toHaveCount(
		0,
	);
	await expect(
		menu.getByTestId("picker-checkout-notice-continue"),
	).toBeVisible();
	await menu.getByTestId("picker-row-checkout").click();
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
		title: "Could not recreate worktree",
		toast: "Could not recreate worktree: its branch no longer exists",
	},
	{
		tag: "ContinueSessionInMainFolder",
		label: "Continue in main folder",
		error: new WorkspaceMoveError({ path: main, reason: "missing" }),
		title: "Could not continue in main folder",
		toast: "That worktree no longer exists.",
	},
]) {
	test(`${failure.label} preserves a typed recovery error toast`, async ({
		page,
		harness,
	}, testInfo) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const { rpc } = await openMissingSession(page, harness.appBaseUrl);
		rpc.setStubs({
			[failure.tag]: () => {
				throw failure.error;
			},
		});
		await page
			.locator(
				'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
			)
			.click();
		await page
			.getByTestId(
				`picker-checkout-notice-${failure.tag === "RecreateSessionWorktree" ? "recreate" : "continue"}`,
			)
			.click();
		await expect(
			page.getByRole("alert").getByText(failure.title, { exact: true }),
		).toBeVisible();
		await expect(page.getByRole("alert")).toContainText(failure.toast);
		await expect(
			page.locator('[data-testid="workspace-notice-indicator"]:visible'),
		).toBeVisible();
		await capture(page, testInfo, "workspace-recovery-error");
	});
}
