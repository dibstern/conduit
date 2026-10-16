import type {
	ProjectInfo,
	SessionInfo,
} from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// Failure modes: folder status collapses to primary; branches or dirty flags
// cross rows; one git folder changes the existing popover; settings omit repo
// identity, show workspace branches, mislabel non-git or collide on basenames.
test.use({ recording: "chat-simple", viewport: { width: 1440, height: 900 } });

for (const scenario of [
	"multiple",
	"colliding",
	"single",
	"non-git-primary",
] as const) {
	test(`git folder details and project settings: ${scenario}`, async ({
		page,
		harness,
	}, testInfo) => {
		const slug = "e2e-replay";
		const gitPrimary = scenario !== "non-git-primary";
		const primary = gitPrimary ? "/workspace/web" : "/workspace/notes";
		const secondary =
			scenario === "colliding" ? "/other/web" : "/workspace/api";
		const scratch = gitPrimary ? "/workspace/notes" : "/workspace/scratch";
		const multiple = scenario !== "single";
		const git = {
			...(gitPrimary
				? { branch: "feature/web", dirty: false, ahead: 0, behind: 0 }
				: {}),
			folders: [
				...(gitPrimary
					? [
							{
								root: primary,
								label: scenario === "colliding" ? primary : "web",
								branch: "feature/web",
								dirty: false,
								ahead: 0,
								behind: 0,
							},
						]
					: []),
				...(multiple
					? [
							{
								root: secondary,
								label: scenario === "colliding" ? secondary : "api",
								branch: "feature/api",
								dirty: true,
								ahead: 2,
								behind: 1,
							},
						]
					: []),
			],
		};
		const project: ProjectInfo = {
			slug,
			title: "Folders project",
			folders: [primary, ...(multiple ? [secondary] : []), scratch],
			git,
			repositoryIdentities: {
				...(gitPrimary
					? {
							[primary]: {
								key: "example.test/team/Frontend",
								name: "Frontend",
								root: primary,
							},
						}
					: {}),
				...(multiple
					? {
							[secondary]: {
								key: "example.test/team/Backend",
								name: "Backend",
								root: secondary,
							},
						}
					: {}),
			},
		};
		const session: SessionInfo = {
			accountId: null,
			id: "git-folders-session",
			title: "Git folders",
			status: "idle",
			projectSlug: slug,
			git,
		};
		await mockWsRpc(page, {
			stubs: {
				FindFolders: () => ({ home: "/workspace", entries: [] }),
				ListDaemonSessions: () => ({
					sessions: [session],
					availability: [],
					hasMore: false,
					nextCursor: null,
				}),
			},
			handlers: {
				GetModels: ({ projectSlug }) => ({ projectSlug, providers: [] }),
				GetProjects: () => ({ projects: [project], current: slug }),
				GetAgents: () => ({
					projectSlug: slug,
					agents: [],
					providerScope: { id: "claude", name: "Claude" },
					instanceId: "claude",
				}),
			},
		});
		await mockRelayWebSocket(page, {
			initMessages: [
				{ type: "project_list", projects: [project], current: slug },
				{ type: "shell_snapshot", roots: true, sessions: [session] },
			],
			responses: new Map(),
		});
		await page.goto(`${harness.relayBaseUrl}/s/${session.id}`);
		const pill = page.getByTestId("composer-checkout");
		await expect(pill).toContainText(gitPrimary ? "feature/web" : "notes");
		await expect(pill.locator("[data-icon]")).toHaveAttribute(
			"data-icon",
			gitPrimary ? "branch" : "folder",
		);
		await expect(pill.locator('[data-part="dirty"]')).toHaveCount(0);
		await pill.click();
		const menu = page.getByRole("menu", { name: "Checkout" });
		await expect(menu).toBeVisible();
		const rows = menu.getByTestId("session-folder-git");
		const folderDetails = git.folders.length > 1 || !gitPrimary;
		await expect(rows).toHaveCount(folderDetails ? git.folders.length : 0);
		if (folderDetails) {
			for (const [index, folder] of git.folders.entries()) {
				await expect(rows.nth(index)).toHaveAttribute(
					"data-folder-root",
					folder.root,
				);
				await expect(rows.nth(index)).toContainText(folder.label);
				await expect(rows.nth(index)).toContainText(folder.branch);
				await expect(rows.nth(index)).toContainText(
					folder.dirty ? "uncommitted" : "clean",
				);
				await expect(rows.nth(index)).toContainText(
					`↑${folder.ahead} ↓${folder.behind}`,
				);
			}
		} else {
			await expect(menu).toContainText("Branch");
			await expect(menu).toContainText("feature/web");
			await expect(menu).toContainText("Folder");
			await expect(menu).toContainText(primary);
		}
		await page.screenshot({
			path: testInfo.outputPath("git-folders-popover.png"),
			animations: "disabled",
		});
		await page.keyboard.press("Escape");
		const back = page.getByTestId("session-bar-back");
		if (await back.isVisible()) await back.click();
		await page.getByTestId("session-scope-chip").click();
		const scope = page.getByRole("menu", { name: "Project scope" });
		const projectRow = scope
			.getByRole("menuitemradio")
			.filter({ hasText: `project:${slug}` });
		await projectRow.hover();
		await projectRow.getByTestId("session-scope-edit").click();
		const dialog = page.getByRole("dialog", {
			name: "Edit project",
			exact: true,
		});
		await expect(dialog).toBeVisible();
		const folderRows = dialog.getByTestId("project-folder-row");
		await expect(folderRows).toHaveCount(project.folders.length);
		if (gitPrimary) {
			await expect(folderRows.nth(0)).toContainText("Frontend");
			await expect(folderRows.nth(0)).toContainText("feature/web");
		} else
			await expect(folderRows.nth(0)).toContainText("Not a git repository");
		if (multiple) {
			await expect(folderRows.nth(1)).toContainText("Backend");
			await expect(folderRows.nth(1)).toContainText("feature/api");
		}
		await expect(folderRows.last()).toContainText("Not a git repository");
		await testInfo.attach("folder-git-status", {
			body: `${JSON.stringify({ git: git.folders, settings: await folderRows.allTextContents() }, null, 2)}\n`,
			contentType: "application/json",
		});
		await page.screenshot({
			path: testInfo.outputPath("git-project-folders.png"),
			animations: "disabled",
		});
	});
}
