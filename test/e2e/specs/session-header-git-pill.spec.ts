import type { Page, TestInfo } from "@playwright/test";
import type { SessionGit } from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
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

async function openHeader(
	page: Page,
	relayBaseUrl: string,
	options: {
		directory?: string;
		git?: SessionGit;
		sessionGit?: SessionGit;
		skills?: boolean;
		viewActivity?: boolean;
	},
) {
	const directory = options.directory ?? "/workspace/conduit";
	const projects = [
		{
			slug: "e2e-replay",
			title: "Display title differs",
			directory,
			...(options.git ? { git: options.git } : {}),
		},
	];
	const sessions = [
		{
			id: "header-session",
			title: "Session header",
			status: "idle",
			projectSlug: "e2e-replay",
			...(options.sessionGit ? { git: options.sessionGit } : {}),
		},
	];
	await mockWsRpc(page, {
		handlers: {
			GetProjects: () => ({ projects, current: "e2e-replay" }),
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
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: "e2e-replay" },
			{ type: "shell_snapshot", roots: true, sessions },
			...(options.viewActivity
				? [{ type: "pty_output", ptyId: "pty-1", data: "activity" }]
				: []),
		],
		responses: new Map(),
	});
	await page.goto(`${relayBaseUrl}/s/header-session`);
	const pill = page.getByTestId("session-bar-identity");
	await expect(pill).toBeVisible();
	await expect(page.getByTestId("session-bar-title")).toHaveText(
		"Session header",
	);
	return pill;
}

for (const mode of [
	{ name: "desktop", viewport: { width: 1440, height: 900 }, hasTouch: false },
	{ name: "phone", viewport: { width: 390, height: 844 }, hasTouch: true },
] as const) {
	test.describe(`${mode.name} session header git pill`, () => {
		test.use({ viewport: mode.viewport, hasTouch: mode.hasTouch });

		test("dirty checkout opens details and copies branch and primary folder", async ({
			page,
			harness,
		}, testInfo) => {
			const directory = "/workspace/conduit/";
			const pill = await openHeader(page, harness.relayBaseUrl, {
				directory,
				git: { branch: "main", dirty: true, ahead: 0, behind: 0 },
			});
			await expect(pill).toHaveAttribute("title", "conduit / main");
			await expect(pill.locator('[data-part="project"]')).toHaveText("conduit");
			await expect(pill.locator('[data-part="branch"]')).toHaveText("main");
			await expect(pill).toContainText("/");
			await expect(pill.locator('[data-part="dirty"]')).toBeVisible();
			const dot = await pill.locator('[data-part="dirty"]').boundingBox();
			expect(dot?.width).toBe(6);
			expect(dot?.height).toBe(6);
			const group = page.locator(".session-bar-segments");
			expect((await group.boundingBox())?.height).toBe(24);
			await expect(group.locator(":scope > *")).toHaveCount(
				mode.hasTouch ? 1 : 2,
			);
			await expect(page.getByTestId("session-skills-chip")).toHaveCount(0);
			const borders = await group
				.locator(":scope > *")
				.evaluateAll((segments) =>
					segments.map((segment) => getComputedStyle(segment).borderLeftWidth),
				);
			expect(borders).toEqual(mode.hasTouch ? ["0px"] : ["0px", "1px"]);
			await capture(page, testInfo, `${mode.name}-dirty-header`);
			if (mode.hasTouch) await pill.tap();
			else await pill.click();
			const details = page.getByRole("menu", { name: "Checkout" });
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
			await pill.click();
			await details.getByRole("menuitem", { name: "Copy branch name" }).click();
			await expect
				.poll(() => page.evaluate(() => navigator.clipboard.readText()))
				.toBe("main");
		});

		test("linked worktree uses the worktree icon and keeps its name in details", async ({
			page,
			harness,
		}, testInfo) => {
			const pill = await openHeader(page, harness.relayBaseUrl, {
				git: { branch: "fix/draft-menus", worktree: "conduit-wt-draft" },
			});
			await expect(
				pill.locator('[data-part="worktree"][data-icon="worktree"] svg'),
			).toBeVisible();
			await expect(pill).not.toContainText("conduit-wt-draft");
			await capture(page, testInfo, `${mode.name}-linked-worktree`);
			await pill.click();
			await expect(
				page
					.getByRole("menu", { name: "Checkout" })
					.getByText("conduit-wt-draft", { exact: true }),
			).toBeVisible();
		});

		test("a folder without git shows only its basename", async ({
			page,
			harness,
		}, testInfo) => {
			const pill = await openHeader(page, harness.relayBaseUrl, {
				directory: "/workspace/ai-notes",
			});
			await expect(pill).toHaveText("ai-notes");
			await expect(pill.locator('[data-icon="folder"] svg')).toBeVisible();
			await expect(pill.locator('[data-part="branch"]')).toHaveCount(0);
			await pill.click();
			await expect(
				page.getByRole("menuitem", { name: "Copy branch name" }),
			).toHaveCount(0);
			await capture(page, testInfo, `${mode.name}-no-git-details`);
		});

		test("long project names keep four letters plus the ellipsis and a visible branch", async ({
			page,
			harness,
		}, testInfo) => {
			const pill = await openHeader(page, harness.relayBaseUrl, {
				directory:
					"/workspace/spm-architecture-deepening-with-a-very-long-project-name",
				git: { branch: "docs/architecture-deepening-design", dirty: true },
			});
			const project = pill.locator('[data-part="project"]');
			const geometry = await project.evaluate((element) => {
				const probe = document.createElement("span");
				probe.style.cssText = `position:absolute;width:5ch;font:${getComputedStyle(element).font}`;
				element.append(probe);
				const floor = probe.getBoundingClientRect().width;
				probe.remove();
				return {
					width: element.getBoundingClientRect().width,
					floor,
					clipped: element.scrollWidth > element.clientWidth,
				};
			});
			expect(geometry.width).toBeGreaterThanOrEqual(geometry.floor - 0.1);
			expect(geometry.clipped).toBe(true);
			const branch = pill.locator('[data-part="branch"]');
			await expect(branch).toBeVisible();
			expect((await branch.boundingBox())?.width).toBeGreaterThan(10);
			expect((await pill.boundingBox())?.width).toBeLessThanOrEqual(
				mode.hasTouch ? 150 : 240,
			);
			await capture(page, testInfo, `${mode.name}-long-names`);
		});

		test("detached HEAD shows the commit glyph and short SHA", async ({
			page,
			harness,
		}, testInfo) => {
			const pill = await openHeader(page, harness.relayBaseUrl, {
				git: { head: "a1b2c3d" },
			});
			await expect(pill).toHaveAttribute("title", "conduit / a1b2c3d");
			await expect(pill.locator('[data-icon="commit"] svg')).toBeVisible();
			await pill.click();
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
			const pill = await openHeader(page, harness.relayBaseUrl, {
				git: {
					branch: "feat/x",
					ahead: 3,
					behind: 1,
					operation: "rebase",
				},
			});
			await expect(pill.getByText("rebasing", { exact: true })).toBeVisible();
			if (mode.hasTouch) await expect(pill).not.toContainText("↑3");
			else await expect(pill).toContainText("↑3 ↓1");
			await capture(page, testInfo, `${mode.name}-checkout-marks`);
			await pill.click();
			await expect(
				page
					.getByRole("menu", { name: "Checkout" })
					.getByText("↑3 ↓1", { exact: true }),
			).toBeVisible();
		});

		test("a merged branch keeps its success mark", async ({
			page,
			harness,
		}, testInfo) => {
			const pill = await openHeader(page, harness.relayBaseUrl, {
				git: { branch: "feat/x", merged: true },
			});
			await expect(pill.getByText("merged", { exact: true })).toBeVisible();
			await capture(page, testInfo, `${mode.name}-merged`);
		});

		test("long operation and status marks stay inside the pill", async ({
			page,
			harness,
		}, testInfo) => {
			const pill = await openHeader(page, harness.relayBaseUrl, {
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
			await expect(pill.locator('[data-part="operation"]')).toHaveText(
				"cherry-picking",
			);
			// Phones show one status word, and the operation outranks merged.
			if (mode.hasTouch)
				await expect(pill.locator('[data-part="merged"]')).toHaveCount(0);
			else
				await expect(pill.locator('[data-part="merged"]')).toHaveText("merged");
			const layout = await pill.evaluate((button) => {
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
			const pill = await openHeader(page, harness.relayBaseUrl, {
				git: { branch: "main" },
				sessionGit: { branch: "session-checkout", dirty: true },
			});
			await expect(pill).toHaveAttribute("title", "conduit / session-checkout");
			await expect(pill.locator('[data-part="dirty"]')).toBeVisible();
			await capture(page, testInfo, `${mode.name}-session-checkout`);
		});

		test("skills share the group without clipping their pulse", async ({
			page,
			harness,
		}, testInfo) => {
			await openHeader(page, harness.relayBaseUrl, {
				git: { branch: "main" },
				skills: true,
			});
			const group = page.locator(".session-bar-segments");
			await expect(group.locator(":scope > *")).toHaveCount(
				mode.hasTouch ? 2 : 3,
			);
			const borders = await group
				.locator(":scope > *")
				.evaluateAll((segments) =>
					segments.map((segment) => getComputedStyle(segment).borderLeftWidth),
				);
			expect(borders).toEqual(
				mode.hasTouch ? ["0px", "1px"] : ["0px", "1px", "1px"],
			);
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
				await openHeader(page, harness.relayBaseUrl, {
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
