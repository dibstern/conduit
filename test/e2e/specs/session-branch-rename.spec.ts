/*
 * Failure cases, written before the UI implementation:
 * - Invalid refs, names taken in the second folder, missing worktrees,
 *   HEAD mismatches and second-folder Git failures show the folder and reason,
 *   preserve the typed draft, and leave the old branch in the pill and row.
 * - Existing-worktree moves and forks without launch ownership have no rename item.
 * - Renaming to the same name remains valid and sends the normal RPC.
 * - Cancelling never sends a rename; success refreshes the pill and session row
 *   from git status immediately. Deletion uses the renamed ownership downstream.
 */
import { writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { WorktreeBranchRenameError } from "../../../src/lib/contracts/worktree.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

const projectSlug = "e2e-replay";
const sessionId = "rename-session";
const folders = ["/workspace/app", "/workspace/api"] as const;
const branch = "conduit/session-rename";
const renamedBranch = "feature/renamed-session";
const worktrees = Object.fromEntries(
	folders.map((folder) => [
		folder,
		`/conduit/worktrees/${projectSlug}/${sessionId}/${folder.split("/").pop()}`,
	]),
);
const controls = new WeakMap<Page, RpcMockControl>();

async function openSession(
	page: Page,
	baseUrl: string,
	options: {
		ownership?: "owned" | "existing" | "fork";
		error?: WorktreeBranchRenameError;
	} = {},
) {
	const ownership = options.ownership ?? "owned";
	const projects = [
		{ slug: projectSlug, title: "App", folders, git: { branch: "main" } },
	];
	let session: SessionInfo = {
		accountId: null,
		id: sessionId,
		title: "Rename this branch",
		status: "idle",
		projectSlug,
		canRenameBranch: ownership === "owned",
		...(ownership === "fork" ? { parentID: "parent-session" } : {}),
		workspace: {
			cause: ownership === "existing" ? "user" : "launch",
			origin: ownership === "existing" ? "existing" : "conduit",
			worktrees,
		},
		git: {
			branch,
			worktree: "app",
			dirty: false,
			folders: folders.map((root) => ({
				root,
				label: root.split("/").pop() ?? root,
				branch,
				worktree: root.split("/").pop() ?? root,
				dirty: false,
			})),
		},
	};
	const rpc = await mockWsRpc(page, {
		stubs: {
			RenameSessionBranch: ({ branchName }) => {
				if (options.error) throw options.error;
				if (typeof branchName !== "string")
					throw new Error("Missing branch name");
				session = {
					...session,
					git: {
						...session.git,
						branch: branchName,
						folders:
							session.git?.folders?.map((folder) => ({
								...folder,
								branch: branchName,
							})) ?? [],
					},
				};
				// The server forces git status and publishes rows before answering.
				// Keep the older family snapshot to catch stale-family precedence.
				rpc.upsertShellRow(session);
				return { ok: true };
			},
			ListDaemonSessions: () => ({
				sessions: [session],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			GetModels: () => ({
				defaultOpenCodeInstanceId: "opencode",
				projectSlug: "e2e-replay",
				providers: [],
			}),
			GetProjects: () => ({ projects, current: projectSlug }),
		},
	});
	rpc.setShellRows([session]);
	rpc.setFamilyRows([session]);
	controls.set(page, rpc);
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: projectSlug },
			{ type: "shell_snapshot", roots: true, sessions: [session] },
		],
		responses: new Map(),
	});
	await page.goto(`${baseUrl}/s/${sessionId}`);
	await expect(page.locator("#input")).toBeVisible();
	return rpc;
}

test.afterEach(async ({ page }, info) => {
	const rpc = controls.get(page);
	const requests =
		rpc
			?.getRequests()
			.filter(({ tag }) => tag === "RenameSessionBranch")
			.map(({ tag, payload }) => ({
				tag,
				payload: {
					_tag: tag,
					...Object.fromEntries(
						Object.entries(payload).filter(([key]) => key !== "originId"),
					),
				},
			})) ?? [];
	const artifact = info.outputPath("session-branch-rename.json");
	writeFileSync(
		artifact,
		`${JSON.stringify({ requests, sessions: rpc?.shellRows }, null, 2)}\n`,
	);
	await info.attach("session-branch-rename", {
		path: artifact,
		contentType: "application/json",
	});
	const screenshot = info.outputPath("session-branch-rename.png");
	await page.screenshot({ path: screenshot, animations: "disabled" });
	await info.attach("session-branch-rename", {
		path: screenshot,
		contentType: "image/png",
	});
});

const failures = [
	{
		name: "invalid ref name",
		branchName: "bad..name",
		folder: folders[0],
		reason: "invalid-name",
		message: "Invalid branch name bad..name",
	},
	{
		name: "name taken in the second folder",
		branchName: "feature/taken",
		folder: folders[1],
		reason: "already-exists",
		message: "Branch feature/taken already exists",
	},
	{
		name: "second worktree deleted on disk",
		branchName: renamedBranch,
		folder: folders[1],
		reason: "worktree-missing",
		message: "The session worktree no longer exists",
	},
	{
		name: "HEAD moved off the owned branch",
		branchName: renamedBranch,
		folder: folders[1],
		reason: "head-mismatch",
		message: "HEAD is not on the owned branch conduit/session-rename",
	},
	{
		name: "Git fails in the second folder and rolls back the first",
		branchName: renamedBranch,
		folder: folders[1],
		reason: "git-failed",
		message: "Git branch rename failed: simulated second-folder failure",
	},
] as const;

for (const mode of [
	{ name: "desktop", viewport: { width: 1440, height: 900 }, hasTouch: false },
	{ name: "phone", viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
	test.describe(mode.name, () => {
		test.use({ viewport: mode.viewport, hasTouch: mode.hasTouch });
		const press = (target: Locator) =>
			mode.hasTouch ? target.tap() : target.click();
		// Phones keep the session checkout in the composer's ⋯ sheet.
		const checkout = async (page: Page) => {
			const target = page.getByTestId("composer-checkout");
			if (mode.hasTouch && !(await target.isVisible()))
				await press(page.getByTestId("composer-more"));
			return target;
		};
		// The ⋯ sheet is modal, so the session bar is inert until it closes.
		const backToList = async (page: Page) => {
			await page.keyboard.press("Escape");
			await expect(page.getByRole("dialog", { name: "Composer" })).toBeHidden();
			await press(page.getByTestId("session-bar-back"));
		};

		async function openRename(page: Page) {
			await press(await checkout(page));
			const menu = page.getByRole("menu", { name: "Checkout" });
			await press(
				menu.getByRole("menuitem", { name: "Rename branch", exact: true }),
			);
			const dialog = page.getByRole("dialog", {
				name: "Rename branch",
				exact: true,
			});
			await expect(dialog).toBeVisible();
			await expect(
				dialog.getByRole("textbox", { name: "Branch name" }),
			).toHaveValue(branch);
			return dialog;
		}

		for (const newName of [renamedBranch, branch]) {
			test(`renaming to ${newName} sends the RPC and immediately refreshes git`, async ({
				page,
				harness,
			}) => {
				const rpc = await openSession(page, harness.relayBaseUrl);
				const dialog = await openRename(page);
				await dialog
					.getByRole("textbox", { name: "Branch name" })
					.fill(newName);
				await press(
					dialog.getByRole("button", { name: "Rename", exact: true }),
				);
				const request = await rpc.waitForRequest(
					({ tag }) => tag === "RenameSessionBranch",
				);
				expect(request.payload).toEqual({
					_tag: "RenameSessionBranch",
					projectSlug,
					sessionId,
					branchName: newName,
				});
				await expect(dialog).not.toBeVisible();
				await expect(await checkout(page)).toContainText(newName);
				await press(await checkout(page));
				const folderRows = page
					.getByRole("menu", { name: "Checkout" })
					.getByTestId("session-folder-git");
				await expect(folderRows).toHaveCount(2);
				for (const row of await folderRows.all())
					await expect(row).toContainText(newName);
				await page.keyboard.press("Escape");
				// Navigation reuses the pushed row; the mock never polls new git.
				if (mode.hasTouch) await backToList(page);
				const row = page.locator(
					`#session-list [data-session-id="${sessionId}"]`,
				);
				await expect(row).toContainText(newName);
				const current = rpc.shellRows?.[0] as SessionInfo | undefined;
				expect(current?.workspace?.worktrees).toEqual(worktrees);
			});
		}

		for (const ownership of ["existing", "fork"] as const) {
			test(`${ownership} workspace without launch ownership has no rename item`, async ({
				page,
				harness,
			}) => {
				const rpc = await openSession(page, harness.relayBaseUrl, {
					ownership,
				});
				await press(await checkout(page));
				const menu = page.getByRole("menu", { name: "Checkout" });
				await expect(menu).toBeVisible();
				await expect(
					menu.getByRole("menuitem", { name: "Rename branch", exact: true }),
				).toHaveCount(0);
				expect(
					rpc.getRequests().filter(({ tag }) => tag === "RenameSessionBranch"),
				).toHaveLength(0);
			});
		}

		for (const failure of failures) {
			test(`${failure.name} keeps the draft open and names the folder and reason`, async ({
				page,
				harness,
			}) => {
				const rpc = await openSession(page, harness.relayBaseUrl, {
					error: new WorktreeBranchRenameError({
						folder: failure.folder,
						reason: failure.reason,
						message: failure.message,
					}),
				});
				const dialog = await openRename(page);
				const input = dialog.getByRole("textbox", { name: "Branch name" });
				await input.fill(failure.branchName);
				await press(
					dialog.getByRole("button", { name: "Rename", exact: true }),
				);
				await expect(dialog.getByRole("alert")).toContainText(failure.folder);
				await expect(dialog.getByRole("alert")).toContainText(failure.message);
				await expect(dialog).toBeVisible();
				await expect(input).toHaveValue(failure.branchName);
				await expect(input).toHaveAttribute("aria-invalid", "true");
				await expect(await checkout(page)).toContainText(branch);
				const current = rpc.shellRows?.[0] as SessionInfo | undefined;
				expect(current?.git?.folders?.map(({ branch: name }) => name)).toEqual([
					branch,
					branch,
				]);
				await rpc.waitForRequest(({ tag }) => tag === "RenameSessionBranch");
				const screenshot = test
					.info()
					.outputPath("session-branch-rename-error.png");
				await page.screenshot({ path: screenshot, animations: "disabled" });
				await test.info().attach("session-branch-rename-error", {
					path: screenshot,
					contentType: "image/png",
				});
				await press(
					dialog.getByRole("button", { name: "Cancel", exact: true }),
				);
				if (mode.hasTouch) await backToList(page);
				await expect(
					page.locator(`#session-list [data-session-id="${sessionId}"]`),
				).toContainText(branch);
			});
		}

		test("cancelling keeps the branch and sends no RPC", async ({
			page,
			harness,
		}) => {
			const rpc = await openSession(page, harness.relayBaseUrl);
			const dialog = await openRename(page);
			await dialog
				.getByRole("textbox", { name: "Branch name" })
				.fill(renamedBranch);
			await press(dialog.getByRole("button", { name: "Cancel", exact: true }));
			await expect(dialog).not.toBeVisible();
			expect(
				rpc.getRequests().filter(({ tag }) => tag === "RenameSessionBranch"),
			).toHaveLength(0);
			await expect(await checkout(page)).toContainText(branch);
		});
	});
}
