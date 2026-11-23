import type { Page, TestInfo } from "@playwright/test";
import { WorkspaceMoveError } from "../../../src/lib/contracts/session-workspace.js";
import { inspectTouchTarget } from "../../../src/lib/frontend/stories/touch-target.js";
import type {
	SessionGit,
	SessionWorkspace,
	WorktreeInfo,
} from "../../../src/lib/shared-types.js";
import { openCheckoutDetails } from "../helpers/model-picker.js";
import { expect, test } from "../helpers/replay-fixture.js";
import {
	mockWsRpc,
	rowActivity,
	sendMockShellRowPatch,
} from "../helpers/rpc-mock.js";
import { settleSheet } from "../helpers/sheet-drag.js";
import { mockDaemonWebSocket } from "../helpers/ws-mock.js";

test.use({
	recording: "chat-simple",
	permissions: ["clipboard-read", "clipboard-write"],
});

async function capture(page: Page, testInfo: TestInfo, name: string) {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path, animations: "disabled" });
	await testInfo.attach(name, { path, contentType: "image/png" });
}

async function openCheckout(
	page: Page,
	appBaseUrl: string,
	options: {
		provider?: string;
		supportsWorktree?: boolean | undefined;
		status?: "idle" | "busy";
		directory?: string;
		git?: SessionGit;
		sessionGit?: SessionGit;
		workspace?: SessionWorkspace;
		worktrees?: readonly WorktreeInfo[];
		canonicalDirectory?: string;
		moveError?: WorkspaceMoveError;
		onmove?: (path: string) => void;
		skills?: boolean;
		viewActivity?: boolean;
	},
) {
	await page.addInitScript(() => {
		localStorage.setItem(
			"conduit-composer-preferences",
			JSON.stringify({ controls: "words" }),
		);
	});
	const directory = options.directory ?? "/workspace/conduit";
	const instances = {
		instances: [
			{
				id: options.provider ?? "opencode",
				name: "Session provider",
				driver: options.provider === "claude" ? "claude" : "opencode",
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 0,
			},
		],
		providerCapabilities:
			options.supportsWorktree === undefined
				? {}
				: {
						[options.provider ?? "claude"]: {
							supportsMultiFolder: true,
							supportsWorktree: options.supportsWorktree,
						},
					},
	};
	const projects = [
		{
			slug: "e2e-replay",
			title: "Display title differs",
			folders: [directory] as const,
			...(options.git ? { git: options.git } : {}),
		},
	];
	const sessions = [
		{
			accountId: options.provider ?? "opencode",
			id: "header-session",
			title: "Session header",
			status: options.status ?? "idle",
			activity: rowActivity(options.status === "busy"),
			projectSlug: "e2e-replay",
			...(options.sessionGit ? { git: options.sessionGit } : {}),
			...(options.workspace ? { workspace: options.workspace } : {}),
		},
	];
	const rpc = await mockWsRpc(page, {
		stubs: {
			ListWorktrees: (scope) => ({
				worktrees: options.worktrees ?? [],
				...(options.canonicalDirectory &&
				"sessionId" in scope &&
				scope.sessionId === "header-session"
					? { directory: options.canonicalDirectory }
					: {}),
			}),
			MoveSessionWorkspace: ({ path }) => {
				options.onmove?.(String(path));
				if (options.moveError) throw options.moveError;
				return { directory: String(path) };
			},
			ListDaemonSessions: () => ({
				sessions,
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			GetModels: () => ({
				projectSlug: "e2e-replay",
				providers: [],
			}),
			GetAgents: () => ({
				projectSlug: "e2e-replay",
				agents: [],
				providerScope: {
					id: options.provider ?? "opencode",
					name: "Session provider",
				},
				instanceId: options.provider ?? "opencode",
			}),
			GetSessionSkills: () => ({
				loads: options.skills
					? [
							{
								name: "release-notes",
								invokedBy: "agent",
								turnOrdinal: 1,
								at: Date.now(),
								anchor: { messageId: "skill-message" },
								running: true,
							},
						]
					: [],
			}),
			GetProjects: () => ({ projects, current: "e2e-replay" }),
		},
		...(options.viewActivity
			? {
					streams: {
						SubscribePtys: () => [
							{
								_tag: "snapshot",
								rows: [
									{
										pty: {
											id: "pty-1",
											title: "Shell",
											command: "zsh",
											cwd: directory,
											status: "running",
											pid: 1,
										},
										scrollback: "",
									},
								],
							},
							{ _tag: "synchronized" },
							{ _tag: "output", ptyId: "pty-1", data: "activity" },
						],
					},
				}
			: {}),
	});
	await mockDaemonWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: "e2e-replay" },
			{ type: "shell_snapshot", roots: true, sessions },
		],
		responses: new Map(),
	});
	rpc.setDaemonList("SubscribeInstances", instances);
	await page.goto(`${appBaseUrl}/s/header-session`);
	const trigger = page.locator(
		'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
	);
	await expect(trigger).toBeVisible();
	if ((page.viewportSize()?.width ?? 1440) < 768) {
		await expect(trigger.locator('[data-part="label"]')).toHaveCount(0);
		await expect(
			trigger.locator(
				options.git ? '[data-icon="branch"]' : '[data-icon="folder"]',
			),
		).toBeVisible();
	}
	const bar = page.getByTestId("session-bar");
	await expect(bar.getByRole("button", { name: /^Checkout:/ })).toHaveCount(0);
	await expect(
		bar.getByRole("button", { name: "Select instance" }),
	).toHaveCount(0);
	await expect(page.getByTestId("session-bar-title")).toHaveText(
		"Session header",
	);
	return trigger;
}

for (const mode of [
	{ name: "desktop", viewport: { width: 1440, height: 900 }, hasTouch: false },
	{ name: "phone", viewport: { width: 390, height: 844 }, hasTouch: true },
] as const) {
	test.describe(`${mode.name} composer checkout`, () => {
		test.use({ viewport: mode.viewport, hasTouch: mode.hasTouch });

		test("dirty checkout opens details and copies branch and primary folder", async ({
			page,
			harness,
		}, testInfo) => {
			const directory = "/workspace/conduit/";
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				directory,
				git: {
					branch: "main",
					head: "6b11104",
					oid: "6b11104a9c2e88d27395d13c706d876fbab99aa1",
					upstream: "origin/main",
					dirty: true,
					ahead: 0,
					behind: 0,
					changes: { files: 3, insertions: 12, deletions: 4 },
				},
			});
			await expect(trigger).toHaveAttribute("title", "conduit / main");
			// Phone keeps only the icon; desktop Words names the branch.
			await expect(trigger.locator('[data-part="project"]')).toHaveCount(0);
			if (mode.hasTouch) {
				await expect(trigger.locator('[data-part="branch"]')).toHaveCount(0);
			} else {
				await expect(trigger.locator('[data-part="branch"]')).toHaveText(
					"main",
				);
			}
			await expect(trigger.locator('[data-part="dirty"]')).toBeVisible();
			await expect(trigger.locator('[data-part="dirty"]')).toHaveText(
				"Uncommitted changes",
			);
			await expect(trigger.locator('[data-part="dirty"] .sr-only')).toHaveText(
				"Uncommitted changes",
			);
			const dot = await trigger.locator('[data-part="dirty"]').boundingBox();
			expect(dot?.width).toBe(6);
			expect(dot?.height).toBe(6);
			// It follows the branch, and a truncating branch never pushes it out.
			const bounds = await trigger.boundingBox();
			expect(dot?.x).toBeGreaterThanOrEqual(bounds?.x ?? 0);
			expect((dot?.x ?? 0) + 6).toBeLessThanOrEqual(
				(bounds?.x ?? 0) + (bounds?.width ?? 0),
			);
			await expect(page.getByTestId("session-skills-chip")).toHaveCount(0);
			await capture(page, testInfo, `${mode.name}-dirty-composer`);
			const details = await openCheckoutDetails(page);
			await expect(details).toBeVisible();
			await expect(details.getByText(directory, { exact: true })).toBeVisible();
			await expect(details.getByTestId("checkout-changes")).toHaveText(
				"3+12-4files changed",
			);
			await expect(details.getByTestId("checkout-ahead")).toHaveText("0ahead");
			await expect(details.getByTestId("checkout-behind")).toHaveText(
				"0behind",
			);
			await expect(
				details.getByText("origin/main", { exact: true }),
			).toBeVisible();
			await capture(page, testInfo, `${mode.name}-checkout-details`);
			await details.getByRole("button", { name: "Copy worktree path" }).click();
			await expect
				.poll(() => page.evaluate(() => navigator.clipboard.readText()))
				.toBe(directory);
			await expect(details).toBeVisible();
			await details.getByRole("button", { name: "Copy branch name" }).click();
			await expect
				.poll(() => page.evaluate(() => navigator.clipboard.readText()))
				.toBe("main");
			await expect(details).toBeVisible();
			await details.getByRole("button", { name: "Copy commit hash" }).click();
			await expect
				.poll(() => page.evaluate(() => navigator.clipboard.readText()))
				.toBe("6b11104a9c2e88d27395d13c706d876fbab99aa1");
		});

		test("linked worktree keeps its branch and name in checkout details", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				git: { branch: "fix/draft-menus", worktree: "conduit-wt-draft" },
			});
			if (!mode.hasTouch)
				await expect(
					trigger.locator('[data-part="worktree"][data-icon="worktree"] svg'),
				).toBeVisible();
			await expect(trigger).not.toContainText("conduit-wt-draft");
			await capture(page, testInfo, `${mode.name}-linked-worktree`);
			await openCheckoutDetails(page);
			await expect(
				page
					.getByTestId("checkout-details")
					.getByText("conduit-wt-draft", { exact: true }),
			).toBeVisible();
		});

		test("agent EnterWorktree and ExitWorktree update the selected session during its running turn", async ({
			page,
			harness,
		}, testInfo) => {
			await page.clock.setFixedTime(new Date("2026-10-06T10:00:00Z"));
			const main = "/workspace/conduit";
			const worktree = `${main}/.claude/worktrees/header-agent`;
			const mainGit: SessionGit = {
				branch: "main",
				dirty: false,
				ahead: 0,
				behind: 0,
			};
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				provider: "claude",
				supportsWorktree: true,
				status: "busy",
				directory: main,
				git: mainGit,
				sessionGit: mainGit,
			});
			const stages: ReadonlyArray<{
				name: string;
				tool: "EnterWorktree" | "ExitWorktree" | null;
				directory: string;
				workspace: SessionWorkspace | null;
				git: SessionGit;
			}> = [
				{
					name: "main",
					tool: null,
					directory: main,
					workspace: null,
					git: mainGit,
				},
				{
					name: "entered",
					tool: "EnterWorktree",
					directory: worktree,
					workspace: {
						cause: "agent",
						worktrees: { [main]: worktree },
						origin: "existing",
					},
					git: {
						branch: "worktree-header-agent",
						worktree: "header-agent",
						dirty: true,
						ahead: 1,
						behind: 0,
					},
				},
				{
					name: "exited",
					tool: "ExitWorktree",
					directory: main,
					workspace: null,
					git: mainGit,
				},
			];
			const observations = [];
			for (const stage of stages) {
				// Workspace changes now arrive as live SubscribeShell row upserts.
				if (stage.tool)
					sendMockShellRowPatch(page, "header-session", () => ({
						workspace: stage.workspace,
						git: stage.git,
					}));
				await expect(page).toHaveURL(/\/s\/header-session$/);
				await expect(page.getByTestId("session-bar-title")).toHaveText(
					"Session header",
				);
				await expect(
					page.getByRole("button", { name: "Stop generating" }),
				).toBeVisible();
				const running = await page
					.getByRole("button", { name: "Stop generating" })
					.isVisible();
				const folder = stage.directory.split("/").at(-1);
				await expect(trigger).toHaveAttribute(
					"title",
					`${folder} / ${stage.git.branch}`,
				);
				await expect(trigger.locator('[data-part="project"]')).toHaveCount(0);
				if (mode.hasTouch)
					await expect(trigger.locator('[data-part="branch"]')).toHaveCount(0);
				else
					await expect(trigger.locator('[data-part="branch"]')).toHaveText(
						stage.git.branch ?? "",
					);
				if (!mode.hasTouch)
					await expect(trigger.locator("[data-icon]")).toHaveAttribute(
						"data-icon",
						stage.git.worktree ? "worktree" : "branch",
					);
				await expect(trigger.locator('[data-part="dirty"]')).toHaveCount(
					stage.git.dirty ? 1 : 0,
				);
				await capture(
					page,
					testInfo,
					`${mode.name}-agent-${stage.name}-composer`,
				);
				const details = await openCheckoutDetails(page);
				await expect(details).toBeVisible();
				const checkout = {
					Worktree: await details
						.getByRole("button", { name: "Copy worktree path" })
						.locator("bdi")
						.innerText(),
					Branch: await details
						.locator('[data-part="checkout-branch"]')
						.innerText(),
				};
				expect(checkout["Worktree"]).toBe(stage.directory);
				expect(checkout["Branch"]).toBe(stage.git.branch);
				if (stage.git.worktree)
					await expect(
						details.getByText(stage.git.worktree, { exact: true }),
					).toBeVisible();
				observations.push({
					stage: stage.name,
					tool: stage.tool,
					selectedSession: new URL(page.url()).pathname,
					running,
					label: await trigger.getAttribute("title"),
					icon: mode.hasTouch
						? null
						: await trigger.locator("[data-icon]").getAttribute("data-icon"),
					checkout,
				});
				await capture(
					page,
					testInfo,
					`${mode.name}-agent-${stage.name}-details`,
				);
				await page.keyboard.press("Escape");
				await expect(details).not.toBeVisible();
			}
			await testInfo.attach(`${mode.name}-agent-worktree-lifecycle.json`, {
				body: Buffer.from(JSON.stringify(observations, null, 2)),
				contentType: "application/json",
			});
		});

		test("a folder without git shows only its basename", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				directory: "/workspace/ai-notes",
			});
			await expect(trigger).toHaveText(mode.hasTouch ? "" : "ai-notes");
			await expect(trigger.locator('[data-icon="folder"] svg')).toBeVisible();
			await expect(trigger.locator('[data-part="branch"]')).toHaveCount(0);
			await expect(
				trigger.locator('[title="Uncommitted changes"]'),
			).toHaveCount(0);
			await openCheckoutDetails(page);
			await expect(
				page.getByRole("button", { name: "Copy branch name" }),
			).toHaveCount(0);
			await capture(page, testInfo, `${mode.name}-no-git-details`);
		});

		test("a moved session shows its folder and lists worktrees with the current one ticked", async ({
			page,
			harness,
		}, testInfo) => {
			const main = "/workspace/conduit";
			const moved = "/workspace/conduit-one";
			const other = "/workspace/conduit-two";
			const moves: string[] = [];
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				provider: "claude",
				git: { branch: "main" },
				sessionGit: {
					branch: "feature/one",
					worktree: "conduit-one",
					dirty: true,
				},
				workspace: {
					cause: "user",
					worktrees: { [main]: moved },
					origin: "existing",
				},
				worktrees: [
					{ path: main, branch: "main", main: true },
					{ path: moved, branch: "feature/one", main: false },
					{ path: other, branch: "feature/two", main: false },
				],
				onmove: (path) => moves.push(path),
			});
			await expect(trigger).toHaveAttribute(
				"title",
				"conduit-one / feature/one",
			);
			if (!mode.hasTouch)
				await expect(
					trigger.locator('[data-icon="worktree"] svg'),
				).toBeVisible();
			const details = await openCheckoutDetails(page);
			await expect(
				details.getByRole("button", { name: "Copy worktree path" }),
			).toContainText(moved);
			const current = details
				.getByTestId("picker-worktree")
				.filter({ hasText: "feature/one" });
			await expect(
				current.locator('[data-testid="current-worktree"]'),
			).toBeVisible();
			await expect(
				details.getByTestId("picker-worktree").filter({ hasText: "main" }),
			).toBeVisible();
			await capture(page, testInfo, `${mode.name}-worktree-list`);
			await details
				.getByTestId("picker-worktree")
				.filter({ hasText: "feature/two" })
				.click();
			await expect.poll(() => moves).toEqual([other]);
		});

		for (const supportsWorktree of [false, true, undefined]) {
			test(`workspace move visibility follows the session capability: ${supportsWorktree}`, async ({
				page,
				harness,
			}) => {
				await openCheckout(page, harness.appBaseUrl, {
					provider: supportsWorktree === false ? "opencode" : "claude",
					supportsWorktree,
					git: { branch: "main" },
				});
				const details = await openCheckoutDetails(page);
				// An omitted override uses Claude's enabled driver capability.
				await expect(
					details.getByText("Worktrees", { exact: true }),
				).toHaveCount(supportsWorktree === false ? 0 : 1);
			});
		}

		test("a symlinked primary folder ticks its canonical reset destination", async ({
			page,
			harness,
		}, testInfo) => {
			const directory = "/workspace/conduit-alias/packages/app";
			const canonicalDirectory = "/real/conduit/packages/app";
			await openCheckout(page, harness.appBaseUrl, {
				provider: "claude",
				directory,
				canonicalDirectory,
				git: { branch: "main" },
				worktrees: [
					{ path: canonicalDirectory, branch: "main", main: true },
					{ path: "/real/conduit", branch: "main", main: true },
					{ path: "/real/conduit-one", branch: "feature/one", main: false },
				],
			});
			const details = await openCheckoutDetails(page);
			const destination = details
				.getByTestId("picker-worktree")
				.filter({ hasText: canonicalDirectory });
			await expect(destination.getByTestId("current-worktree")).toBeVisible();
			await expect(details.getByTestId("current-worktree")).toHaveCount(1);
			await capture(page, testInfo, `${mode.name}-symlinked-primary`);
		});

		test("an invalid workspace move shows the typed reason in a toast", async ({
			page,
			harness,
		}) => {
			const path = "/workspace/removed";
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				provider: "claude",
				git: { branch: "main" },
				worktrees: [{ path, branch: "feature/removed", main: false }],
				moveError: new WorkspaceMoveError({ path, reason: "missing" }),
			});
			const details = await openCheckoutDetails(page);
			await details
				.getByTestId("picker-worktree")
				.filter({ hasText: "feature/removed" })
				.click();
			const toast = page.getByRole("alert");
			await expect(
				toast.getByText("Could not move session", { exact: true }),
			).toBeVisible();
			await expect(
				toast.getByText("That worktree no longer exists.", { exact: true }),
			).toBeVisible();
			await expect(trigger).toHaveAttribute("title", "conduit / main");
		});

		test("long project names and branches fit inside the composer", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				directory:
					"/workspace/spm-architecture-deepening-with-a-very-long-project-name",
				git: { branch: "docs/architecture-deepening-design", dirty: true },
			});
			for (const viewport of [
				mode.viewport,
				...(mode.hasTouch ? [{ width: 320, height: 640 }] : []),
			]) {
				await page.setViewportSize(viewport);
				const project = trigger.locator('[data-part="project"]');
				await expect(project).toHaveCount(0);
				const branch = trigger.locator('[data-part="branch"]');
				if (mode.hasTouch) await expect(branch).toHaveCount(0);
				else {
					await expect(branch).toBeVisible();
					expect((await branch.boundingBox())?.width).toBeGreaterThan(10);
				}
				const checkoutBox = await trigger.boundingBox();
				const composerBox = await page.locator("#input-area").boundingBox();
				expect(checkoutBox).not.toBeNull();
				expect(composerBox).not.toBeNull();
				if (!checkoutBox || !composerBox)
					throw new Error("Composer checkout missing");
				expect(checkoutBox.x).toBeGreaterThanOrEqual(composerBox.x);
				expect(checkoutBox.x + checkoutBox.width).toBeLessThanOrEqual(
					composerBox.x + composerBox.width,
				);
				for (const part of mode.hasTouch ? [] : ["branch"]) {
					const height = await trigger
						.locator(`[data-part="${part}"]`)
						.evaluate((element) => ({
							actual: element.getBoundingClientRect().height,
							line: Number.parseFloat(getComputedStyle(element).lineHeight),
						}));
					expect(height.actual).toBeLessThanOrEqual(height.line + 1);
				}
				await capture(
					page,
					testInfo,
					`${mode.name}-long-names-${viewport.width}px`,
				);
			}
		});

		test("detached HEAD shows the short SHA and checkout details", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				git: { head: "a1b2c3d" },
			});
			await expect(trigger).toHaveAttribute("title", "conduit / a1b2c3d");
			if (!mode.hasTouch)
				await expect(trigger.locator('[data-icon="commit"] svg')).toBeVisible();
			await openCheckoutDetails(page);
			await expect(
				page.getByText("Detached at a1b2c3d", { exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Copy branch name" }),
			).toHaveCount(0);
			await capture(page, testInfo, `${mode.name}-detached-details`);
		});

		test("upstream counts and operation labels stay desktop-only in the chip", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				git: {
					branch: "feat/x",
					ahead: 3,
					behind: 1,
					operation: "rebase",
				},
			});
			if (mode.hasTouch)
				await expect(
					trigger.getByText("rebasing", { exact: true }),
				).toHaveCount(0);
			else
				await expect(
					trigger.getByText("rebasing", { exact: true }),
				).toBeVisible();
			if (mode.hasTouch) await expect(trigger).not.toContainText("↑3");
			else await expect(trigger).toContainText("↑3 ↓1");
			await capture(page, testInfo, `${mode.name}-checkout-marks`);
			const menu = await openCheckoutDetails(page);
			await expect(menu.getByTestId("checkout-ahead")).toHaveText("3ahead");
			await expect(menu.getByTestId("checkout-behind")).toHaveText("1behind");
		});

		test("a merged branch keeps its success mark", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				git: { branch: "feat/x", merged: true },
			});
			if (mode.hasTouch)
				await expect(trigger.getByText("merged", { exact: true })).toHaveCount(
					0,
				);
			else
				await expect(
					trigger.getByText("merged", { exact: true }),
				).toBeVisible();
			await capture(page, testInfo, `${mode.name}-merged`);
		});

		test("long operation and status marks stay inside the checkout", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				git: {
					branch: "main",
					dirty: true,
					ahead: 3,
					behind: 1,
					operation: "cherry-pick",
					merged: true,
				},
				skills: true,
			});
			if (mode.hasTouch) {
				await expect(trigger.locator('[data-part="operation"]')).toHaveCount(0);
				await expect(trigger.locator('[data-part="merged"]')).toHaveCount(0);
			} else {
				await expect(trigger.locator('[data-part="operation"]')).toHaveText(
					"cherry-picking",
				);
				await expect(trigger.locator('[data-part="merged"]')).toHaveText(
					"merged",
				);
			}
			const layout = await trigger.evaluate((button) => {
				const box = button.getBoundingClientRect();
				return {
					labelWidth:
						button
							.querySelector('[data-part="project"], [data-part="branch"]')
							?.getBoundingClientRect().width ?? 0,
					contained: Array.from(button.children).every((child) => {
						const childBox = child.getBoundingClientRect();
						return childBox.left >= box.left && childBox.right <= box.right;
					}),
				};
			});
			if (mode.hasTouch) expect(layout.labelWidth).toBe(0);
			else expect(layout.labelWidth).toBeGreaterThan(10);
			expect(layout.contained).toBe(true);
			if (mode.hasTouch) {
				const back = page.getByTestId("session-bar-back");
				await expect(back).toHaveAccessibleName("Sessions");
				const backBox = await back.boundingBox();
				const groupBox = await page
					.locator(".session-bar-segments")
					.boundingBox();
				const moreBox = await page
					.getByTestId("session-bar-island-overflow")
					.boundingBox();
				expect(backBox).not.toBeNull();
				expect(groupBox).not.toBeNull();
				expect(moreBox).not.toBeNull();
				if (!backBox || !groupBox || !moreBox)
					throw new Error("Header control missing");
				// The outlined back circle keeps its 44px touch area.
				const target = await back.evaluate(inspectTouchTarget, 44);
				expect(target.width).toBeGreaterThanOrEqual(44);
				expect(target.height).toBeGreaterThanOrEqual(44);
				expect(target.missing, JSON.stringify(target.failures)).toBe(0);
				expect(backBox.x + backBox.width).toBeLessThanOrEqual(groupBox.x);
				expect(groupBox.x + groupBox.width).toBeLessThanOrEqual(moreBox.x);
				expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(
					mode.viewport.width,
				);
			}
			await capture(page, testInfo, `${mode.name}-long-operation`);
		});

		test("session checkout takes precedence over project git", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.appBaseUrl, {
				git: { branch: "main" },
				sessionGit: { branch: "session-checkout", dirty: true },
			});
			await expect(trigger).toHaveAttribute(
				"title",
				"conduit / session-checkout",
			);
			await expect(trigger.locator('[data-part="dirty"]')).toBeVisible();
			await capture(page, testInfo, `${mode.name}-session-checkout`);
		});

		test("header skills and Settle keep their group without clipping the pulse", async ({
			page,
			harness,
		}, testInfo) => {
			await openCheckout(page, harness.appBaseUrl, {
				git: { branch: "main" },
				skills: true,
			});
			const group = page.locator(".session-bar-segments");
			await expect(group.locator(":scope > *")).toHaveCount(2);
			// Phone segments divide with a border; the desktop capsule with a 1px rule.
			const dividers = await group
				.locator(":scope > *")
				.evaluateAll((segments) =>
					segments.map((segment) => {
						const rule = getComputedStyle(segment, "::after");
						return rule.content === "none"
							? getComputedStyle(segment).borderLeftWidth
							: rule.width;
					}),
				);
			expect(dividers).toEqual(["0px", "1px"]);
			const pulse = page.getByTestId("session-skills-chip-pulse");
			await expect(pulse).toBeVisible();
			const clipping = await pulse.evaluate((element) => {
				const clipped: string[] = [];
				for (
					let parent = element.parentElement;
					parent && parent.id !== "session-bar";
					parent = parent.parentElement
				) {
					if (getComputedStyle(parent).overflow === "hidden")
						clipped.push(parent.id || parent.className);
				}
				return clipped;
			});
			expect(clipping).toEqual([]);
			await capture(page, testInfo, `${mode.name}-skills-group`);
		});

		if (mode.hasTouch)
			test("overflow opens the Views sheet in the expanded first row", async ({
				page,
				harness,
			}, testInfo) => {
				await openCheckout(page, harness.appBaseUrl, {
					git: { branch: "main" },
					viewActivity: true,
				});
				await expect(
					page.locator(
						'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
					),
				).toBeVisible();
				await expect(page.getByTestId("session-bar-views-button")).toHaveCount(
					0,
				);
				const overflow = page.getByTestId("session-bar-island-overflow");
				await expect(
					overflow.getByTestId("session-bar-view-badge"),
				).toContainText("1");
				await capture(page, testInfo, "phone-overflow-count");
				await overflow.tap();
				const sheet = page.getByTestId("session-bar-island-menu");
				await expect(sheet).toBeVisible();
				await expect(sheet.getByTestId("session-sheet-header")).toBeVisible();
				for (const view of ["chat", "terminal", "diff", "files"])
					await expect(
						sheet.getByTestId(`overflow-view-${view}`),
					).toBeVisible();
				await settleSheet(page);
				// The Views sheet drops down from under the header.
				await expect
					.poll(async () => {
						const header = await page.locator("#session-bar").boundingBox();
						const box = await sheet.boundingBox();
						return header && box
							? Math.abs(box.y - header.y - header.height)
							: Infinity;
					})
					.toBeLessThan(1);
				const box = await sheet.boundingBox();
				expect(box?.x).toBe(0);
				expect(box?.width).toBe(390);
				await capture(page, testInfo, "phone-overflow-views-sheet");
			});
	});
}
