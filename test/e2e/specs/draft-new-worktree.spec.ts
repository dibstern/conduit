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
const modelProviders = ["claude", "anthropic"].map((id) => ({
	id,
	name: id === "claude" ? "Claude" : "Anthropic",
	configured: true,
	models: [
		{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: id },
	],
}));

async function openDraft(
	page: Page,
	baseUrl: string,
	options: {
		provider?: "claude" | "opencode";
		supportsWorktree?: boolean;
		supportsNewWorktree?: boolean;
		switchProviders?: boolean;
		multiFolder?: boolean;
		nonGitPrimary?: boolean;
		git?: boolean;
		fail?: boolean;
		secondProject?: boolean;
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
		...(options.secondProject
			? [
					{
						slug: "second",
						title: "Second project",
						instanceId: provider,
						folders: ["/workspace/second"],
						git: { branch: "develop" },
					},
				]
			: []),
	];
	const instances = {
		instances: [
			{
				id: provider,
				name: "Draft provider",
				driver: provider,
				supportsWorktree: options.supportsWorktree ?? provider === "claude",
				supportsNewWorktree: options.supportsNewWorktree ?? true,
			},
			...(options.switchProviders
				? [
						{
							id: "opencode",
							name: "OpenCode",
							driver: "opencode",
							supportsWorktree: false,
							supportsNewWorktree: true,
						},
						{
							id: "limited-provider",
							name: "Local provider",
							driver: "opencode",
							supportsWorktree: false,
							supportsNewWorktree: false,
						},
					]
				: []),
		].map(
			({ supportsWorktree, supportsNewWorktree, ...instance }, index, all) => ({
				...instance,
				// The daemon marks one default account per harness; drafts resolve to it.
				isDefault:
					all.findIndex(({ driver }) => driver === instance.driver) === index,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 0,
				capabilities: {
					supportsMultiFolder: true,
					supportsWorktree,
					supportsNewWorktree,
				},
			}),
		),
	};
	let sessions: readonly Record<string, unknown>[] = [];
	let workspaceCreated = false;
	const rpc = await mockWsRpc(page, {
		handlers: {
			GetProjects: () => ({ projects, current: "e2e-replay" }),
			GetInstances: () => instances,
			GetModels: ({ projectSlug, instanceId }) => ({
				projectSlug,
				providers: modelProviders.filter(
					({ id }) => id === (instanceId === "claude" ? "claude" : "anthropic"),
				),
			}),
			GetAgents: ({ instanceId }) => ({
				projectSlug: "e2e-replay",
				instanceId: instanceId ?? provider,
				providerScope: { id: instanceId ?? provider, name: "Draft provider" },
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
			ListBranches: ({ projectSlug }) =>
				projectSlug === "second"
					? { current: "develop", branches: ["develop", "main"] }
					: options.nonGitPrimary
						? { branches: [] }
						: { current: "main", branches: ["feature/base", "main"] },
			ListWorktrees: () => ({
				worktrees: [
					{ path: main, branch: "main", main: true },
					{
						path: "/workspace/existing",
						branch: "feature/existing",
						main: false,
					},
				],
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
			PreWarmDraft: () => undefined,
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
	for (const account of instances.instances.filter(
		({ driver }) => driver === "claude",
	))
		rpc.setProjectSetting({
			_tag: "providerModels",
			accountId: account.id,
			providers: modelProviders.filter(({ id }) => id === "claude"),
		});
	rpc.setProjectSetting({
		_tag: "harnessDefaults",
		claude: {
			status: "ok",
			pick: {
				providerId: "claude",
				modelId: "claude-sonnet-4-5",
				effort: "",
				contextWindow: "",
			},
		},
		opencode: {
			status: "ok",
			pick: {
				providerId: "anthropic",
				modelId: "claude-sonnet-4-5",
				effort: "",
				contextWindow: "",
			},
		},
	});
	rpc.setProjectSetting({
		_tag: "defaultModel",
		model: "claude-sonnet-4-5",
		provider: provider === "claude" ? "claude" : "anthropic",
		variant: "",
	});
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
		// Phones keep the session checkout in the composer's ⋯ sheet.
		const checkout = async (page: Page) => {
			if (mode.hasTouch) await press(page.getByTestId("composer-more"));
			return page.getByTestId("composer-checkout");
		};

		test("New worktree starts on a generated branch and renders the worktree pill", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await expect(page.getByTestId("draft-base-branch-chip")).toHaveCount(0);
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
			const basePicker = page.getByTestId("draft-base-branch-chip");
			await expect(basePicker).toHaveText("from main");
			expect(
				rpc.getRequests().filter(({ tag }) => tag === "ListBranches"),
			).toEqual([]);
			await press(basePicker);
			const current = page.getByRole("menuitemradio", {
				name: "main",
				exact: true,
			});
			await expect(current).toHaveAttribute("aria-checked", "true");
			await press(current);
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
			expect(request.payload).not.toHaveProperty("worktreeBase");
			await rpc.waitForRequest(({ tag }) => tag === "input.submit");
			const pill = await checkout(page);
			await expect(pill).toContainText(branch);
			await expect(pill.locator('[data-icon="worktree"]')).toBeVisible();
		});

		test("picking another local branch sends its base in CreateSession", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitem", { name: "New worktree", exact: true }),
			);
			await press(page.getByTestId("draft-base-branch-chip"));
			await press(
				page.getByRole("menuitemradio", { name: "feature/base", exact: true }),
			);
			await expect(page.getByTestId("draft-base-branch-chip")).toHaveText(
				"from feature/base",
			);
			await page.locator("#input").fill("Start from the feature branch");
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).toMatchObject({
				_tag: "CreateSession",
				newWorktree: true,
				worktreeBase: "feature/base",
			});
			await rpc.waitForRequest(({ tag }) => tag === "input.submit");
		});

		test("the selected base survives switching between phone and desktop composer layouts", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitem", { name: "New worktree", exact: true }),
			);
			await press(page.getByTestId("draft-base-branch-chip"));
			await press(
				page.getByRole("menuitemradio", { name: "feature/base", exact: true }),
			);
			await page.setViewportSize(
				mode.hasTouch
					? { width: 1440, height: 900 }
					: { width: 390, height: 844 },
			);
			await expect(page.getByTestId("draft-base-branch-chip")).toHaveText(
				"from feature/base",
			);
			await page.setViewportSize(mode.viewport);
			await expect(page.getByTestId("draft-base-branch-chip")).toHaveText(
				"from feature/base",
			);
			await page.locator("#input").fill("Keep the selected base");
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).toMatchObject({
				newWorktree: true,
				worktreeBase: "feature/base",
			});
			await rpc.waitForRequest(({ tag }) => tag === "input.submit");
		});

		test("Existing worktree hides the base picker and sends only its path", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl);
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitem", { name: "New worktree", exact: true }),
			);
			await press(page.getByTestId("draft-base-branch-chip"));
			await press(
				page.getByRole("menuitemradio", { name: "feature/base", exact: true }),
			);
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitem", { name: "Existing worktree", exact: true }),
			);
			await press(
				page.getByRole("menuitemradio", { name: /feature\/existing/ }),
			);
			await expect(page.getByTestId("draft-base-branch-chip")).toHaveCount(0);
			await page.locator("#input").fill("Use the existing checkout");
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).toMatchObject({
				worktreePath: "/workspace/existing",
			});
			expect(request.payload).not.toHaveProperty("worktreeBase");
			expect(request.payload).not.toHaveProperty("newWorktree");
			await rpc.waitForRequest(({ tag }) => tag === "input.submit");
		});

		test("changing projects resets the chosen base to the new project's current branch", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl, {
				secondProject: true,
			});
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitem", { name: "New worktree", exact: true }),
			);
			await press(page.getByTestId("draft-base-branch-chip"));
			await press(
				page.getByRole("menuitemradio", { name: "feature/base", exact: true }),
			);
			await press(page.getByTestId("draft-project-chip"));
			await press(page.getByRole("menuitemradio", { name: /Second project/ }));
			await expect(page.getByTestId("draft-base-branch-chip")).toHaveCount(0);
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitem", { name: "New worktree", exact: true }),
			);
			await expect(page.getByTestId("draft-base-branch-chip")).toHaveText(
				"from develop",
			);
			await press(page.getByTestId("draft-base-branch-chip"));
			const current = page.getByRole("menuitemradio", {
				name: "develop",
				exact: true,
			});
			await expect(current).toHaveAttribute("aria-checked", "true");
			await press(current);
			await page.locator("#input").fill("Use the new project's default");
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).toMatchObject({
				projectSlug: "second",
				newWorktree: true,
			});
			expect(request.payload).not.toHaveProperty("worktreeBase");
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
				await press(await checkout(page));
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
					// The ⋯ sheet is modal, so the session bar is inert until it closes.
					await page.keyboard.press("Escape");
					await expect(
						page.getByRole("dialog", { name: "Composer" }),
					).toBeHidden();
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
			await press(page.getByTestId("draft-base-branch-chip"));
			await press(
				page.getByRole("menuitemradio", { name: "feature/base", exact: true }),
			);
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitemradio", { name: "Current checkout" }),
			);
			await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
			await expect(page.getByTestId("draft-base-branch-chip")).toHaveCount(0);
			await page.locator("#input").fill("Stay local");
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).not.toHaveProperty("newWorktree");
			expect(request.payload).not.toHaveProperty("worktreePath");
			expect(request.payload).not.toHaveProperty("worktreeBase");
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

		test("OpenCode offers New worktree and sends the launch request", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl, {
				provider: "opencode",
			});
			await press(page.getByTestId("draft-start-chip"));
			await expect(
				page.getByRole("menuitem", { name: /^Existing worktree/ }),
			).toHaveAttribute("aria-disabled", "true");
			await press(
				page.getByRole("menuitem", { name: "New worktree", exact: true }),
			);
			await page.locator("#input").fill("Run OpenCode in isolation");
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).toMatchObject({
				instanceId: "opencode",
				newWorktree: true,
			});
			await rpc.waitForRequest(({ tag }) => tag === "input.submit");
		});

		test("switching the draft provider updates the offer and clears unsupported New worktree and base selections", async ({
			page,
			harness,
		}) => {
			const rpc = await openDraft(page, harness.relayBaseUrl, {
				switchProviders: true,
			});
			await page
				.locator("#input")
				.fill("Keep this draft while switching providers");
			await press(page.getByTestId("draft-start-chip"));
			await press(
				page.getByRole("menuitem", { name: "New worktree", exact: true }),
			);
			await press(page.getByTestId("draft-base-branch-chip"));
			await press(
				page.getByRole("menuitemradio", { name: "feature/base", exact: true }),
			);
			const picker = page.locator(
				'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
			);
			for (const provider of [
				"opencode",
				"limited-provider",
				"claude",
				"limited-provider",
			]) {
				await press(picker);
				const back = page.getByTestId("picker-back");
				if (await back.isVisible()) await press(back);
				await press(
					page.getByTestId(
						`picker-harness-${provider === "claude" ? "claude" : "opencode"}`,
					),
				);
				if (provider !== "claude")
					await press(page.getByTestId(`picker-account-${provider}`));
				await page.keyboard.press("Escape");
				await expect(picker).toHaveAttribute("data-instance-id", provider);
				if (provider === "opencode") {
					await expect(page.getByTestId("draft-start-chip")).toHaveText(
						"New worktree",
					);
					await expect(page.getByTestId("draft-base-branch-chip")).toHaveText(
						"from feature/base",
					);
				} else {
					await expect(page.getByTestId("draft-start-chip")).toHaveText("main");
					await expect(page.getByTestId("draft-base-branch-chip")).toHaveCount(
						0,
					);
				}
				await press(page.getByTestId("draft-start-chip"));
				const choice = page.getByRole("menuitem", { name: /New worktree/ });
				if (provider === "limited-provider") {
					await expect(choice).toHaveAttribute("aria-disabled", "true");
					await expect(choice).toContainText("Not supported by Local provider");
				} else {
					await expect(choice).not.toHaveAttribute("aria-disabled", "true");
					await expect(choice).toHaveText("New worktree");
				}
				await page.keyboard.press("Escape");
				await expect(page.locator("#input")).toHaveValue(
					"Keep this draft while switching providers",
				);
			}
			await press(page.locator("#send"));
			const request = await rpc.waitForRequest(
				({ tag }) => tag === "CreateSession",
			);
			expect(request.payload).toMatchObject({ instanceId: "limited-provider" });
			for (const key of ["newWorktree", "worktreePath", "worktreeBase"])
				expect(request.payload).not.toHaveProperty(key);
			await rpc.waitForRequest(({ tag }) => tag === "input.submit");
		});

		for (const options of [
			{ supportsWorktree: false, supportsNewWorktree: false },
			{ git: false },
		]) {
			test(`New worktree stays disabled for ${options.supportsWorktree === false ? "an unsupported provider" : "folders without git"}`, async ({
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
