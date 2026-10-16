import type { Page, TestInfo } from "@playwright/test";
import { WorkspaceMoveError } from "../../../src/lib/contracts/session-workspace.js";
import type {
	SessionGit,
	SessionWorkspace,
	WorktreeInfo,
} from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, sendMockShellRowPatch } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

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
	relayBaseUrl: string,
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
			folders: [directory],
			...(options.git ? { git: options.git } : {}),
		},
	];
	const sessions = [
		{
			accountId: options.provider ?? "opencode",
			id: "header-session",
			title: "Session header",
			status: options.status ?? "idle",
			projectSlug: "e2e-replay",
			...(options.sessionGit ? { git: options.sessionGit } : {}),
			...(options.workspace ? { workspace: options.workspace } : {}),
		},
	];
	const rpc = await mockWsRpc(page, {
		handlers: {
			GetModels: () => ({ projectSlug: "e2e-replay", providers: [] }),
			GetProjects: () => ({ projects, current: "e2e-replay" }),
			GetAgents: () => ({
				projectSlug: "e2e-replay",
				agents: [],
				providerScope: {
					id: options.provider ?? "opencode",
					name: "Session provider",
				},
				instanceId: options.provider ?? "opencode",
			}),
			GetInstances: () => instances,
			ListWorktrees: ({ sessionId }) => ({
				worktrees: options.worktrees ?? [],
				...(options.canonicalDirectory && sessionId === "header-session"
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
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: "e2e-replay" },
			{ type: "shell_snapshot", roots: true, sessions },
		],
		responses: new Map(),
	});
	rpc.setDaemonList("SubscribeInstances", instances);
	await page.goto(`${relayBaseUrl}/s/header-session`);
	const trigger = page.getByTestId("composer-checkout");
	await expect(trigger).toBeVisible();
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
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
				directory,
				git: { branch: "main", dirty: true, ahead: 0, behind: 0 },
			});
			await expect(trigger).toHaveAttribute("title", "conduit / main");
			await expect(trigger.locator('[data-part="project"]')).toHaveText(
				"conduit",
			);
			await expect(trigger.locator('[data-part="branch"]')).toHaveText("main");
			await expect(trigger).toContainText("/");
			await expect(trigger.locator('[data-part="dirty"]')).toBeVisible();
			const dot = await trigger.locator('[data-part="dirty"]').boundingBox();
			expect(dot?.width).toBe(6);
			expect(dot?.height).toBe(6);
			// It badges the icon, so a truncating branch never pushes it out.
			const bounds = await trigger.boundingBox();
			expect(dot?.x).toBeGreaterThanOrEqual(bounds?.x ?? 0);
			expect((dot?.x ?? 0) + 6).toBeLessThanOrEqual(
				(bounds?.x ?? 0) + (bounds?.width ?? 0),
			);
			await expect(page.getByTestId("session-skills-chip")).toHaveCount(0);
			await capture(page, testInfo, `${mode.name}-dirty-composer`);
			if (mode.hasTouch) await trigger.tap();
			else await trigger.click();
			const details = page.getByTestId("composer-checkout-menu");
			await expect(details).toBeVisible();
			await expect(details.getByText(directory, { exact: true })).toBeVisible();
			await expect(
				details.getByText("uncommitted", { exact: true }),
			).toBeVisible();
			await expect(details.getByText("↑0 ↓0", { exact: true })).toBeVisible();
			await capture(page, testInfo, `${mode.name}-checkout-details`);
			await details.getByRole("menuitem", { name: "Copy folder path" }).click();
			await expect
				.poll(() => page.evaluate(() => navigator.clipboard.readText()))
				.toBe(directory);
			await trigger.click();
			await details.getByRole("menuitem", { name: "Copy branch name" }).click();
			await expect
				.poll(() => page.evaluate(() => navigator.clipboard.readText()))
				.toBe("main");
		});

		test("linked worktree uses the worktree icon and keeps its name in details", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
				git: { branch: "fix/draft-menus", worktree: "conduit-wt-draft" },
			});
			await expect(
				trigger.locator('[data-part="worktree"][data-icon="worktree"] svg'),
			).toBeVisible();
			await expect(trigger).not.toContainText("conduit-wt-draft");
			await capture(page, testInfo, `${mode.name}-linked-worktree`);
			await trigger.click();
			await expect(
				page
					.getByTestId("composer-checkout-menu")
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
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
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
				await expect(trigger.locator('[data-part="project"]')).toHaveText(
					folder ?? "",
				);
				await expect(trigger.locator('[data-part="branch"]')).toHaveText(
					stage.git.branch ?? "",
				);
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
				await trigger.click();
				const details = page.getByTestId("composer-checkout-menu");
				await expect(details).toBeVisible();
				const checkout = await details
					.locator("dl")
					.evaluate(
						(list): Record<string, string> =>
							Object.fromEntries(
								Array.from(list.querySelectorAll("dt"), (label) => [
									label.textContent?.trim() ?? "",
									label.nextElementSibling?.textContent?.trim() ?? "",
								]).sort(([left = ""], [right = ""]) =>
									left.localeCompare(right),
								),
							),
					);
				expect(checkout["Folder"]).toBe(stage.directory);
				expect(checkout["Branch"]).toBe(stage.git.branch);
				expect(checkout["Worktree"]).toBe(stage.git.worktree);
				observations.push({
					stage: stage.name,
					tool: stage.tool,
					selectedSession: new URL(page.url()).pathname,
					running,
					label: await trigger.getAttribute("title"),
					icon: await trigger.locator("[data-icon]").getAttribute("data-icon"),
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
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
				directory: "/workspace/ai-notes",
			});
			await expect(trigger).toHaveText("ai-notes");
			await expect(trigger.locator('[data-icon="folder"] svg')).toBeVisible();
			await expect(trigger.locator('[data-part="branch"]')).toHaveCount(0);
			await trigger.click();
			await expect(
				page.getByRole("menuitem", { name: "Copy branch name" }),
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
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
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
			await expect(trigger.locator('[data-icon="worktree"] svg')).toBeVisible();
			await trigger.click();
			const details = page.getByTestId("composer-checkout-menu");
			await expect(details.getByText(moved, { exact: true })).toBeVisible();
			await details
				.getByRole("menuitem", { name: "Move to worktree…" })
				.click();
			const current = details.getByRole("menuitem", { name: /feature\/one/ });
			await expect(
				current.locator('[data-testid="current-worktree"]'),
			).toBeVisible();
			await expect(
				details.getByRole("menuitem", { name: /main/ }),
			).toBeVisible();
			await capture(page, testInfo, `${mode.name}-worktree-list`);
			await details.getByRole("menuitem", { name: /feature\/two/ }).click();
			await expect.poll(() => moves).toEqual([other]);
		});

		for (const supportsWorktree of [false, true, undefined]) {
			test(`workspace move visibility follows the session capability: ${supportsWorktree}`, async ({
				page,
				harness,
			}) => {
				const trigger = await openCheckout(page, harness.relayBaseUrl, {
					provider: supportsWorktree === true ? "claude" : "opencode",
					supportsWorktree,
					git: { branch: "main" },
				});
				await trigger.click();
				await expect(
					page.getByRole("menuitem", { name: "Move to worktree…" }),
				).toHaveCount(supportsWorktree === false ? 0 : 1);
			});
		}

		test("a symlinked primary folder ticks its canonical reset destination", async ({
			page,
			harness,
		}, testInfo) => {
			const directory = "/workspace/conduit-alias/packages/app";
			const canonicalDirectory = "/real/conduit/packages/app";
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
				directory,
				canonicalDirectory,
				git: { branch: "main" },
				worktrees: [
					{ path: canonicalDirectory, branch: "main", main: true },
					{ path: "/real/conduit", branch: "main", main: true },
					{ path: "/real/conduit-one", branch: "feature/one", main: false },
				],
			});
			await trigger.click();
			const details = page.getByTestId("composer-checkout-menu");
			await details
				.getByRole("menuitem", { name: "Move to worktree…" })
				.click();
			const destination = details
				.getByRole("menuitem")
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
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
				git: { branch: "main" },
				worktrees: [{ path, branch: "feature/removed", main: false }],
				moveError: new WorkspaceMoveError({ path, reason: "missing" }),
			});
			await trigger.click();
			await page.getByRole("menuitem", { name: "Move to worktree…" }).click();
			await page.getByRole("menuitem", { name: /feature\/removed/ }).click();
			await expect(
				page.getByText("Could not move session: that folder no longer exists", {
					exact: true,
				}),
			).toBeVisible();
			await expect(trigger).toHaveAttribute("title", "conduit / main");
		});

		test("long project names and branches fit inside the composer", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
				directory:
					"/workspace/spm-architecture-deepening-with-a-very-long-project-name",
				git: { branch: "docs/architecture-deepening-design", dirty: true },
			});
			const project = trigger.locator('[data-part="project"]');
			await expect(project).toBeVisible();
			expect((await project.boundingBox())?.width).toBeGreaterThan(10);
			const branch = trigger.locator('[data-part="branch"]');
			await expect(branch).toBeVisible();
			expect((await branch.boundingBox())?.width).toBeGreaterThan(10);
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
			await capture(page, testInfo, `${mode.name}-long-names`);
		});

		test("detached HEAD shows the commit glyph and short SHA", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
				git: { head: "a1b2c3d" },
			});
			await expect(trigger).toHaveAttribute("title", "conduit / a1b2c3d");
			await expect(trigger.locator('[data-icon="commit"] svg')).toBeVisible();
			await trigger.click();
			await expect(
				page.getByText("Detached at a1b2c3d", { exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("menuitem", { name: "Copy branch name" }),
			).toHaveCount(0);
			await capture(page, testInfo, `${mode.name}-detached-details`);
		});

		test("upstream counts stay desktop-only while the operation remains visible", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
				git: {
					branch: "feat/x",
					ahead: 3,
					behind: 1,
					operation: "rebase",
				},
			});
			await expect(
				trigger.getByText("rebasing", { exact: true }),
			).toBeVisible();
			if (mode.hasTouch) await expect(trigger).not.toContainText("↑3");
			else await expect(trigger).toContainText("↑3 ↓1");
			await capture(page, testInfo, `${mode.name}-checkout-marks`);
			await trigger.click();
			await expect(
				page
					.getByTestId("composer-checkout-menu")
					.getByText("↑3 ↓1", { exact: true }),
			).toBeVisible();
		});

		test("a merged branch keeps its success mark", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
				git: { branch: "feat/x", merged: true },
			});
			await expect(trigger.getByText("merged", { exact: true })).toBeVisible();
			await capture(page, testInfo, `${mode.name}-merged`);
		});

		test("long operation and status marks stay inside the checkout", async ({
			page,
			harness,
		}, testInfo) => {
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
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
			await expect(trigger.locator('[data-part="operation"]')).toHaveText(
				"cherry-picking",
			);
			// Phones show one status word, and the operation outranks merged.
			if (mode.hasTouch)
				await expect(trigger.locator('[data-part="merged"]')).toHaveCount(0);
			else
				await expect(trigger.locator('[data-part="merged"]')).toHaveText(
					"merged",
				);
			const layout = await trigger.evaluate((button) => {
				const box = button.getBoundingClientRect();
				return {
					branchWidth:
						button
							.querySelector('[data-part="branch"]')
							?.getBoundingClientRect().width ?? 0,
					contained: Array.from(button.children).every((child) => {
						const childBox = child.getBoundingClientRect();
						return childBox.left >= box.left && childBox.right <= box.right;
					}),
				};
			});
			expect(layout.branchWidth).toBeGreaterThan(10);
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
				expect(backBox.width).toBeGreaterThanOrEqual(44);
				expect(backBox.height).toBeGreaterThanOrEqual(44);
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
			const trigger = await openCheckout(page, harness.relayBaseUrl, {
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
			await openCheckout(page, harness.relayBaseUrl, {
				git: { branch: "main" },
				skills: true,
			});
			const group = page.locator(".session-bar-segments");
			await expect(group.locator(":scope > *")).toHaveCount(
				mode.hasTouch ? 1 : 2,
			);
			const borders = await group
				.locator(":scope > *")
				.evaluateAll((segments) =>
					segments.map((segment) => getComputedStyle(segment).borderLeftWidth),
				);
			expect(borders).toEqual(mode.hasTouch ? ["0px"] : ["0px", "1px"]);
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
				await openCheckout(page, harness.relayBaseUrl, {
					git: { branch: "main" },
					viewActivity: true,
				});
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
				await expect(sheet.getByText("Views", { exact: true })).toBeVisible();
				for (const view of ["chat", "terminal", "diff", "files"])
					await expect(
						sheet.getByTestId(`overflow-view-${view}`),
					).toBeVisible();
				const box = await sheet.boundingBox();
				expect(box?.x).toBe(0);
				expect(box?.width).toBe(390);
				expect((box?.y ?? 0) + (box?.height ?? 0)).toBeCloseTo(844, 0);
				await capture(page, testInfo, "phone-overflow-views-sheet");
			});
	});
}
