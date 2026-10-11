import { writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { WorktreeCreationError } from "../../../src/lib/contracts/worktree.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

const main = "/workspace/app";
const api = "/workspace/api";
const shared = "/workspace/docs";
const isolated = "/conduit/worktrees/e2e-replay/draft-session/app";
const branch = "conduit/session-draft";
const controls = new WeakMap<Page, RpcMockControl>();

async function openDraft(
	page: Page,
	baseUrl: string,
	options: {
		provider?: "claude" | "opencode";
		multiFolder?: boolean;
		nonGitPrimary?: boolean;
		git?: boolean;
		fail?: boolean;
	} = {},
) {
	const provider = options.provider ?? "claude";
	const folders = options.multiFolder
		? options.nonGitPrimary
			? [shared, main, api]
			: [main, api, shared]
		: [main];
	const roots = folders.map((root) => ({
		root,
		label: root.split("/").pop() ?? root,
	}));
	const gitRoots =
		options.git === false ? [] : roots.filter(({ root }) => root !== shared);
	const projectGit =
		gitRoots.length > 0
			? {
					...(!options.nonGitPrimary ? { branch: "main" } : {}),
					folders: gitRoots.map((folder) => ({ ...folder, branch: "main" })),
				}
			: undefined;
	const projects = [
		{
			slug: "e2e-replay",
			title: "App",
			instanceId: provider,
			folders,
			...(projectGit ? { git: projectGit } : {}),
		},
	];
	const instances = {
		instances: [
			{
				id: provider,
				name: "Draft provider",
				driver: provider,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 0,
				capabilities: {
					supportsMultiFolder: true,
					supportsWorktree: provider === "claude",
				},
			},
		],
	};
	let sessions: readonly Record<string, unknown>[] = [];
	let workspaceCreated = false;
	const rpc = await mockWsRpc(page, {
		handlers: {
			GetProjects: () => ({ projects, current: "e2e-replay" }),
			GetInstances: () => instances,
			GetModels: () => ({ projectSlug: "e2e-replay", providers: [] }),
			GetAgents: () => ({
				projectSlug: "e2e-replay",
				instanceId: provider,
				providerScope: { id: provider, name: "Draft provider" },
				agents: [],
			}),
			ListDaemonSessions: () => ({
				sessions,
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			GetFileTree: () => ({
				projectSlug: "e2e-replay",
				entries: [],
				...(folders.length > 1
					? {
							roots: roots.map((folder) => ({
								...folder,
								...(workspaceCreated && folder.root === shared
									? { shared: true }
									: {}),
							})),
						}
					: {}),
			}),
			GetFileList: ({ root, path = "." }) => ({
				projectSlug: "e2e-replay",
				path,
				...(root ? { root } : {}),
				entries: [],
			}),
			CreateSession: ({ projectSlug, newWorktree }) => {
				if (options.fail)
					throw new WorktreeCreationError({
						reason: "git-failed",
						path: main,
						message: "Could not create worktree: simulated Git failure",
					});
				workspaceCreated = newWorktree === true;
				sessions = [
					{
						id: "draft-session",
						title: "New workspace",
						status: "idle",
						projectSlug,
						workspace: newWorktree
							? {
									cause: "launch",
									origin: "conduit",
									worktrees: Object.fromEntries(
										gitRoots.map(({ root, label }) => [
											root,
											root === main
												? isolated
												: `/conduit/worktrees/e2e-replay/draft-session/${label}`,
										]),
									),
								}
							: null,
						git: newWorktree
							? {
									...(!options.nonGitPrimary
										? { branch, worktree: "app" }
										: {}),
									folders: roots.map((folder) => ({
										...folder,
										...(folder.root === shared
											? { shared: true }
											: { branch, worktree: folder.label, dirty: false }),
									})),
								}
							: projectGit,
					},
				];
				rpc.setShellRows(sessions);
				return { projectSlug, sessionId: "draft-session" };
			},
			PreWarmSession: () => ({ ok: true }),
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: "e2e-replay" },
			{ type: "shell_snapshot", roots: true, sessions: [] },
		],
		responses: new Map(),
	});
	rpc.setDaemonList("SubscribeInstances", instances);
	controls.set(page, rpc);
	await page.goto(`${baseUrl}/new?project=e2e-replay`);
	await expect(page.getByTestId("draft-start-chip")).toHaveText(
		projectGit?.branch ?? "Current folder",
	);
	return rpc;
}

test.afterEach(async ({ page }, info) => {
	const requests =
		controls
			.get(page)
			?.getRequests()
			.filter(({ tag }) => ["CreateSession", "input.submit"].includes(tag))
			.map(({ tag, payload }) => ({
				tag,
				payload: Object.fromEntries(
					Object.entries(payload)
						.filter(([key]) => key !== "originId" && key !== "commandId")
						.sort(([a], [b]) => a.localeCompare(b)),
				),
			})) ?? [];
	const artifact = info.outputPath("new-worktree.json");
	writeFileSync(artifact, `${JSON.stringify({ requests }, null, 2)}\n`);
	await info.attach("new-worktree", {
		path: artifact,
		contentType: "application/json",
	});
	const screenshot = info.outputPath("new-worktree.png");
	await page.screenshot({ path: screenshot, animations: "disabled" });
	await info.attach("new-worktree", {
		path: screenshot,
		contentType: "image/png",
	});
});

for (const mode of [
	{ name: "desktop", viewport: { width: 1440, height: 900 }, hasTouch: false },
	{ name: "phone", viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
	test.describe(mode.name, () => {
		test.use({ viewport: mode.viewport, hasTouch: mode.hasTouch });
		const press = (target: Locator) =>
			mode.hasTouch ? target.tap() : target.click();

		test("New worktree starts on a generated branch and renders the worktree pill", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await page.locator("#input").fill("Work in isolation");
			await press(page.getByTestId("draft-start-chip"));
			const choice = page.getByRole("menuitem", {
				name: "New worktree",
				exact: true,
			});
			await expect(choice).not.toHaveAttribute("aria-disabled", "true");
			await press(choice);
			await expect(page.getByTestId("draft-start-chip")).toHaveText(
				"New worktree",
			);
			await expect(page.locator("#input")).toHaveValue("Work in isolation");
			expect(rpc.getRequests().some(({ tag }) => tag === "CreateSession")).toBe(
				false,
			);
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).toMatchObject({
				projectSlug: "e2e-replay",
				newWorktree: true,
			});
			expect(request.payload).not.toHaveProperty("worktreePath");
			await rpc.waitForRequest(({ tag }) => tag === "input.submit");
			const pill = page.getByTestId("session-bar-identity");
			await expect(pill).toContainText(branch);
			await expect(pill.locator('[data-icon="worktree"]')).toBeVisible();
		});

		for (const nonGitPrimary of [false, true]) {
			test(`multi-folder New worktree is offered with a ${nonGitPrimary ? "non-git" : "git"} primary and labels shared folders`, async ({
				page,
				harness,
			}) => {
				const rpc = await openDraft(page, harness.relayBaseUrl, {
					multiFolder: true,
					nonGitPrimary,
				});
				await press(page.getByTestId("draft-start-chip"));
				const choice = page.getByRole("menuitem", {
					name: "New worktree",
					exact: true,
				});
				await expect(choice).not.toHaveAttribute("aria-disabled", "true");
				await press(choice);
				await expect(page.getByTestId("draft-start-chip")).toHaveText(
					"New worktree",
				);
				await page.locator("#input").fill("Update both repositories");
				await press(page.locator("#send"));
				const request = await rpc.waitForRequest(
					({ tag }) => tag === "CreateSession",
				);
				expect(request.payload).toMatchObject({ newWorktree: true });
				await rpc.waitForRequest(({ tag }) => tag === "input.submit");
				await expect(page.getByTestId("session-bar-title")).toHaveText(
					"New workspace",
				);
				await press(page.getByTestId("session-bar-identity"));
				const rows = page.getByTestId("session-folder-git");
				await expect(rows).toHaveCount(3);
				for (const root of [main, api]) {
					await expect(
						page.locator(
							`[data-testid="session-folder-git"][data-folder-root="${root}"]`,
						),
					).toContainText(branch);
				}
				const sharedRow = page.locator(
					`[data-testid="session-folder-git"][data-folder-root="${shared}"]`,
				);
				await expect(
					sharedRow.getByText("shared", { exact: true }),
				).toBeVisible();
				await expect(sharedRow).not.toContainText(
					/Detached|Branch|Changes|clean/,
				);
				await page.keyboard.press("Escape");
				if (mode.hasTouch) {
					await press(page.getByTestId("session-bar-island-overflow"));
					await press(page.getByTestId("overflow-view-files"));
				} else {
					await press(page.getByTestId("views-rail-files"));
				}
				const fileRoots = page.locator("#file-tree [data-file-root]");
				await expect(fileRoots).toHaveCount(3);
				const sharedRoot = page.locator(
					`#file-tree [data-file-root="${shared}"]`,
				);
				await expect(
					sharedRoot.getByText("shared", { exact: true }),
				).toBeVisible();
				await expect(sharedRoot).toContainText("docs");
				for (const root of [main, api]) {
					await expect(
						page
							.locator(`#file-tree [data-file-root="${root}"]`)
							.getByText("shared", { exact: true }),
					).toHaveCount(0);
				}
			});
		}

		test("Current checkout clears New worktree and keeps the Local request", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitem", { name: "New worktree", exact: true }),
			);
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitemradio", { name: "Current checkout" }),
			);
			await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
			await page.locator("#input").fill("Stay local");
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).not.toHaveProperty("newWorktree");
			expect(request.payload).not.toHaveProperty("worktreePath");
			await rpc.waitForRequest(({ tag }) => tag === "input.submit");
		});

		test("creation errors preserve the draft and never submit a turn", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl, { fail: true });
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitem", { name: "New worktree", exact: true }),
			);
			await page.locator("#input").fill("Keep this draft");
			await press(page.locator("#send"));
			await expect(
				page.getByText("Could not create worktree: simulated Git failure", {
					exact: true,
				}),
			).toBeVisible();
			await expect(page.locator("#input")).toHaveValue("Keep this draft");
			await expect(page.getByTestId("draft-start-chip")).toHaveText(
				"New worktree",
			);
			expect(
				rpc.getRequests().filter(({ tag }) => tag === "input.submit"),
			).toEqual([]);
		});

		for (const options of [{ provider: "opencode" as const }, { git: false }]) {
			test(`New worktree stays disabled for ${options.provider ?? "folders without git"}`, async ({
				page,
				harness,
			}) => {
				const rpc = await openDraft(page, harness.relayBaseUrl, options);
				await press(page.getByTestId("draft-start-chip"));
				await expect(
					page.getByRole("menuitem", { name: /New worktree/ }),
				).toHaveAttribute("aria-disabled", "true");
				expect(
					rpc.getRequests().filter(({ tag }) => tag === "CreateSession"),
				).toEqual([]);
			});
		}
	});
}
