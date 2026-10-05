// Tests responsive sidebar behavior across viewports:
// - Desktop: sidebar visible, collapse/expand toggle
// - Mobile: session list and session are separate routes
// Uses real relay backed by MockOpenCodeServer.

import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";
import { AppPage } from "../page-objects/app.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({ recording: "chat-simple" });

test("shell feed adds and removes sidebar roots", async ({
	page,
	relayUrl,
}) => {
	const rpc = await mockWsRpc(page, {
		handlers: {
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			ViewSession: () => ({ ok: true }),
		},
		streams: {
			SubscribeShell: () => [
				{ _tag: "snapshot", sequence: 1, rows: [] },
				{ _tag: "synchronized" },
			],
		},
	});
	const relay = await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{
						slug: "e2e-replay",
						title: "e2e-replay",
						folders: ["/tmp/e2e-replay"],
					},
				],
				current: "e2e-replay",
			},
		],
		responses: new Map(),
	});
	await page.goto(relayUrl);
	await rpc.waitForRequest((request) => request.tag === "SubscribeShell");
	rpc.sendChunk("SubscribeShell", [
		{
			_tag: "upsert",
			sequence: 2,
			item: {
				id: "feed-root",
				title: "Feed root",
				status: "idle",
				updatedAt: new Date().toISOString(),
			},
		},
	]);
	await expect(
		page.locator('#session-list [data-session-id="feed-root"]'),
	).toBeVisible();
	// Open the row by its title: on desktop hover the row's verbs sit at its centre.
	await page
		.locator('#session-list [data-session-id="feed-root"] .session-item-title')
		.click();
	relay.sendMessage({
		type: "mock_transcript_snapshot",
		id: "feed-root",
		sessionId: "feed-root",
		events: [{ type: "user_message", text: "Chat before deletion" }],
	});
	await expect(page.locator("#messages")).toContainText("Chat before deletion");
	rpc.sendChunk("SubscribeShell", [
		{ _tag: "remove", sequence: 3, id: "feed-root" },
	]);
	await expect(
		page.locator('#session-list [data-session-id="feed-root"]'),
	).toHaveCount(0);
	await expect(page.locator("#messages")).not.toContainText(
		"Chat before deletion",
	);
});

test("shell feed warns after a failed grace period and clears on recovery", async ({
	page,
	relayUrl,
}) => {
	let subscriptions = 0;
	const rpc = await mockWsRpc(page, {
		handlers: {
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
		},
		streams: {
			SubscribeShell: () =>
				++subscriptions === 1
					? [
							{ _tag: "snapshot", sequence: 1, rows: [] },
							{ _tag: "synchronized" },
						]
					: [],
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{
						slug: "e2e-replay",
						title: "e2e-replay",
						folders: ["/tmp/e2e-replay"],
					},
				],
				current: "e2e-replay",
			},
		],
		responses: new Map(),
	});
	await page.goto(relayUrl);
	await rpc.waitForRequest((request) => request.tag === "SubscribeShell");
	rpc.failStream("SubscribeShell", "feed unavailable");
	const warning = page.getByTestId("session-list-stale");
	await expect(warning).toBeHidden();
	await expect(warning).toBeVisible({ timeout: 5_000 });
	await expect
		.poll(
			() =>
				rpc.getRequests().filter((request) => request.tag === "SubscribeShell")
					.length,
		)
		.toBeGreaterThan(1);
	rpc.sendChunk("SubscribeShell", [{ _tag: "synchronized" }]);
	await expect(warning).toBeHidden();
});

test("same-project reconnect keeps a visible stale warning until shell sync", async ({
	page,
	relayUrl,
}) => {
	let subscriptions = 0;
	const rpc = await mockWsRpc(page, {
		handlers: {
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
		},
		streams: {
			SubscribeShell: () =>
				++subscriptions === 1
					? [
							{ _tag: "snapshot", sequence: 1, rows: [] },
							{ _tag: "synchronized" },
						]
					: [],
		},
	});
	const relay = await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{
						slug: "e2e-replay",
						title: "e2e-replay",
						folders: ["/tmp/e2e-replay"],
					},
				],
				current: "e2e-replay",
			},
		],
		responses: new Map(),
	});
	await page.goto(relayUrl);
	await rpc.waitForRequest((request) => request.tag === "SubscribeShell");
	rpc.failStream("SubscribeShell", "feed unavailable");
	const warning = page.getByTestId("session-list-stale");
	await expect(warning).toBeVisible({ timeout: 5_000 });
	const beforeReconnect = subscriptions;
	relay.close();
	await expect.poll(() => subscriptions).toBeGreaterThan(beforeReconnect);
	await expect(warning).toBeVisible();
	rpc.sendChunk("SubscribeShell", [{ _tag: "synchronized" }]);
	await expect(warning).toBeHidden();
});

test("a promptly resynchronized shell feed does not show the stale line", async ({
	page,
	relayUrl,
}) => {
	const rpc = await mockWsRpc(page, {
		handlers: {
			ListDaemonSessions: () => ({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
		},
		streams: {
			SubscribeShell: () => [
				{ _tag: "snapshot", sequence: 1, rows: [] },
				{ _tag: "synchronized" },
			],
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{
						slug: "e2e-replay",
						title: "e2e-replay",
						folders: ["/tmp/e2e-replay"],
					},
				],
				current: "e2e-replay",
			},
		],
		responses: new Map(),
	});
	await page.goto(relayUrl);
	await rpc.waitForRequest((request) => request.tag === "SubscribeShell");
	rpc.closeStreamSocket("SubscribeShell");
	await expect
		.poll(
			() =>
				rpc.getRequests().filter((request) => request.tag === "SubscribeShell")
					.length,
			{ timeout: 5_000 },
		)
		.toBeGreaterThan(1);
	// Negative observation window: the stale line only appears 3s after the
	// feed drops, so wait past that before asserting it never showed.
	await page.waitForTimeout(3_300);
	await expect(page.getByTestId("session-list-stale")).toBeHidden();
});

test.describe("Sidebar Layout — Desktop", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("desktop views rail toggles terminal and files beside chat", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);
		const rail = page.getByTestId("views-rail");
		const terminal = page.getByTestId("views-rail-terminal");
		const files = page.getByTestId("views-rail-files");
		await expect(rail).toBeVisible();
		await expect(rail).toHaveCSS("width", "38px");
		await page.locator("#session-list .session-item").first().click();
		await expect(rail).toBeVisible();
		await expect(page.getByTestId("views-rail-diff")).toBeDisabled();
		await expect(terminal).toHaveAttribute("aria-label", "Terminal");
		await expect(files).toHaveAttribute("aria-label", "Files");
		await terminal.hover();
		await expect(page.getByRole("tooltip")).toContainText("Terminal");
		await page.getByTestId("views-rail-diff").hover({ force: true });
		await expect(page.getByRole("tooltip")).toContainText("Diff");
		await expect(page.locator("#file-browser-btn")).toHaveCount(0);
		await terminal.click();
		await expect(terminal).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator("#terminal-panel")).toBeVisible();
		await files.click();
		await expect(files).toHaveAttribute("aria-pressed", "true");
		const pane = page.getByTestId("side-pane-files");
		await expect(pane).toBeVisible();
		const paneWidth = (await pane.boundingBox())?.width ?? 0;
		expect(paneWidth).toBeGreaterThanOrEqual(280);
		expect(paneWidth).toBeLessThanOrEqual(640);
		await expect(page.locator("#messages")).toBeVisible();
		await expect(
			page.locator("#sidebar-panel-files .fb-entry").first(),
		).toBeVisible();
		const folder = pane.locator(".fb-entry[aria-expanded]").first();
		await folder.click();
		await expect(folder).toHaveAttribute("aria-expanded", "true");
		await page
			.locator("#sidebar-panel-files .fb-entry:not([aria-expanded])")
			.first()
			.click();
		await expect(
			page.getByTestId("side-pane-files").locator("#file-viewer"),
		).toBeVisible();
		await page
			.getByTestId("side-pane-files")
			.getByRole("button", { name: "File browser" })
			.click();
		await expect(
			page.getByTestId("side-pane-files").locator("#file-tree"),
		).toBeVisible();
		await expect(folder).toHaveAttribute("aria-expanded", "true");
		await files.click();
		await expect(page.getByTestId("side-pane-files")).toBeHidden();
		await terminal.click();
		await expect(page.locator("#terminal-panel")).toBeHidden();
	});

	test("desktop panes survive the phone breakpoint and terminal wins on phones", async ({
		page,
		relayUrl,
	}) => {
		await new AppPage(page).goto(relayUrl);
		const files = page.getByTestId("views-rail-files");
		await files.click();
		await page.setViewportSize({ width: 393, height: 852 });
		await expect(page.getByTestId("side-pane-files")).toHaveCount(0);
		await expect(page.locator("#sidebar-panel-files")).toBeVisible();
		await page.setViewportSize({ width: 1440, height: 900 });
		await expect(page.getByTestId("side-pane-files")).toBeVisible();
		await page.getByTestId("views-rail-terminal").click();
		const terminal = page.locator("#terminal-panel");
		const terminalHeight = async () =>
			(await terminal.boundingBox())?.height ?? 0;
		await expect.poll(terminalHeight).toBeLessThan(900 / 2);
		await page.setViewportSize({ width: 393, height: 852 });
		await expect(terminal).toBeVisible();
		await expect(page.locator("#sidebar-panel-files")).toBeHidden();
		// A phone terminal is the whole view, not the desktop's bottom split.
		await expect.poll(terminalHeight).toBeGreaterThan(852 * 0.7);
		await expect
			.poll(async () => (await terminal.boundingBox())?.width)
			.toBe(393);
		await page.setViewportSize({ width: 1440, height: 900 });
		// The phone shows one view, but the desktop panes survive the round trip,
		// and the terminal returns to a bottom panel under the chat.
		await expect(page.getByTestId("side-pane-files")).toBeVisible();
		await expect(terminal).toBeVisible();
		await expect.poll(terminalHeight).toBeLessThan(900 / 2);
	});

	test("desktop: sidebar is visible by default", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Sidebar should be visible
		await expect(app.sidebar).toBeVisible();

		// The sidebar expand button should be hidden when sidebar is open
		await expect(app.sidebarExpandBtn).toBeHidden();
	});

	test("desktop: sidebar chrome shows loaded groups and project identity", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);
		const rows = page.locator("#session-list .session-item");
		await expect(rows.first()).toBeVisible();
		await expect(app.sidebar).toHaveCSS("width", "300px");
		await expect(page.locator("#sidebar-footer")).toHaveCount(0);
		await new SidebarPage(page).createNewSession();
		await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
		await expect(rows.first()).toHaveCSS("margin-bottom", "1px");

		for (const shelf of ["snoozed", "settled"]) {
			const toggle = page.getByTestId(`${shelf}-shelf-toggle`);
			if (await toggle.count()) await toggle.click();
		}
		const headings = page.locator(
			"#session-list-scroller > .session-group-label",
		);
		expect(await headings.count()).toBeGreaterThan(0);
		for (const heading of await headings.all()) {
			const label = (await heading.locator("span").first().innerText()).trim();
			expect(label).toBe(label.toUpperCase());
			const renderedRows = await heading.evaluate((element) => {
				let count = 0;
				let sibling = element.nextElementSibling;
				while (sibling && !sibling.classList.contains("session-group-label")) {
					count += sibling.matches(".session-item")
						? 1
						: sibling.querySelectorAll(".session-item").length;
					sibling = sibling.nextElementSibling;
				}
				return count;
			});
			await expect(heading.locator("span").last()).toHaveText(
				String(renderedRows),
			);
		}

		// The status column is never blank, idle rows included.
		for (const row of await rows.all()) {
			await expect(row.locator(".session-status-glyph svg")).toBeVisible();
		}
		const square = rows.first().locator(".project-square");
		await expect(square).toHaveText(/^[A-Z]{2}$/);
		await expect(square).toHaveCSS("width", "16px");
		await expect(square).toHaveCSS("height", "16px");
		await expect(square).toHaveClass(/bg-project-1/);
		expect(
			await square.evaluate(
				(element) => getComputedStyle(element).backgroundColor,
			),
		).not.toBe("rgba(0, 0, 0, 0)");
		await expect(rows.first().locator(".session-item-context")).toContainText(
			"e2e-replay",
		);
	});

	test("desktop: sidebar toggle collapses and expands", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Sidebar starts visible
		await expect(app.sidebar).toBeVisible();

		// Click the toggle button to collapse
		const toggleBtn = page.locator("#sidebar-toggle-btn");
		await toggleBtn.click();

		// After collapse, the expand button should appear
		await expect(app.sidebarExpandBtn).toBeVisible();

		// Click expand to restore
		await app.sidebarExpandBtn.click();

		// Sidebar visible again
		await expect(app.sidebar).toBeVisible();
	});

	test("merged bar shows identity, status and Share", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Project name always visible
		await expect(app.projectName).toBeVisible();

		// Status dot always visible
		await expect(app.statusDot).toBeVisible();

		await app.moreActionsBtn.click();
		// Share lives in the desktop overflow.
		await expect(app.qrBtn).toBeVisible();
	});

	test("desktop overflow lists global actions and Escape restores focus", async ({
		page,
		relayUrl,
	}) => {
		await new AppPage(page).goto(`${relayUrl}?feats=debug`);
		const more = page.getByTestId("session-bar-overflow");
		await expect(page.getByTestId("session-bar")).toHaveAttribute(
			"data-compact",
			"false",
		);
		await more.click();
		const menu = page.getByTestId("session-bar-overflow-menu");
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem")).toHaveText([
			"Share",
			"Settings",
			"Debug panel",
		]);
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(more).toBeFocused();
	});

	test("open desktop menus close when the viewport becomes a phone", async ({
		page,
		relayUrl,
	}) => {
		await new AppPage(page).goto(relayUrl);
		await page.getByTestId("session-bar-overflow").click();
		await expect(page.getByTestId("session-bar-overflow-menu")).toBeVisible();
		await page.setViewportSize({ width: 393, height: 852 });
		await expect(page.getByTestId("session-bar")).toHaveAttribute(
			"data-compact",
			"true",
		);
		await expect(page.getByTestId("session-bar-overflow-menu")).toHaveCount(0);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.getByTestId("session-bar-title-menu").click();
		await expect(page.getByTestId("session-ctx-menu")).toBeVisible();
		await page.setViewportSize({ width: 393, height: 852 });
		await expect(page.getByTestId("session-bar")).toHaveAttribute(
			"data-compact",
			"true",
		);
		await expect(page.getByTestId("session-ctx-menu")).toHaveCount(0);
	});

	test("desktop bar renders without an open session", async ({
		page,
		relayUrl,
	}) => {
		await new AppPage(page).goto(new URL("/", relayUrl).toString());
		const bar = page.getByTestId("session-bar");
		await expect(bar).toBeVisible();
		await expect(bar).toHaveAttribute("data-compact", "false");
		await expect(bar.getByTestId("session-bar-identity")).toBeVisible();
		await expect(bar.locator("#status")).toBeVisible();
		await expect(bar.getByTestId("session-bar-overflow")).toBeVisible();
		await expect(bar.getByTestId("session-bar-title")).toHaveCount(0);
		await expect(bar.getByTestId("session-bar-settle")).toHaveCount(0);
	});

	test("long title fits the narrow desktop bar without overlap", async ({
		page,
		relayUrl,
	}) => {
		await page.setViewportSize({ width: 800, height: 900 });
		await new AppPage(page).goto(relayUrl);
		await page.getByTestId("session-bar-title-menu").click();
		await page.getByTestId("session-ctx-rename").click();
		const longTitle =
			"Investigate the long running terminal session across every project and linked worktree";
		await page.getByRole("textbox", { name: "Session name" }).fill(longTitle);
		await page.getByRole("textbox", { name: "Session name" }).press("Enter");
		await expect(page.getByTestId("session-bar-title")).toContainText(
			longTitle,
		);
		const layout = await page.getByTestId("session-bar").evaluate((bar) => {
			const bounds = bar.getBoundingClientRect();
			const children = Array.from(bar.children)
				.filter((child) => getComputedStyle(child).display !== "none")
				.map((child) => ({
					id: child.id || child.getAttribute("data-testid"),
					box: child.getBoundingClientRect(),
				}));
			return {
				barWidth: bar.clientWidth,
				scrollWidth: bar.scrollWidth,
				bounds,
				children,
			};
		});
		expect(layout.scrollWidth).toBeLessThanOrEqual(layout.barWidth);
		for (const [index, child] of layout.children.entries()) {
			expect(child.box.left, child.id ?? "child").toBeGreaterThanOrEqual(
				layout.bounds.left,
			);
			expect(child.box.right, child.id ?? "child").toBeLessThanOrEqual(
				layout.bounds.right,
			);
			const previous = layout.children[index - 1];
			if (previous) {
				expect(child.box.left, child.id ?? "child").toBeGreaterThanOrEqual(
					previous.box.right,
				);
			}
		}
	});
});

test.describe("Sidebar Layout — Mobile", () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test("phone file preview returns to the Files view", async ({
		page,
		relayUrl,
	}) => {
		await new AppPage(page).goto(relayUrl);
		const overflowButton = page.getByTestId("session-bar-island-overflow");
		await overflowButton.click();
		await page.getByTestId("overflow-view-files").click();
		await page
			.locator("#sidebar-panel-files .fb-entry:not([aria-expanded])")
			.first()
			.click();
		await expect(page.locator("#file-viewer")).toBeVisible();
		await page
			.locator("#file-viewer")
			.getByRole("button", { name: "File browser" })
			.click();
		await expect(page.locator("#file-viewer")).toBeHidden();
		await expect(page.locator("#sidebar-panel-files")).toBeVisible();
		await overflowButton.click();
		await expect(page.getByTestId("overflow-view-files")).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});

	test("mobile: expanded overflow, collapsed overflow, and title menus use bottom sheets", async ({
		page,
		relayUrl,
	}) => {
		await page.setViewportSize({ width: 393, height: 852 });
		await new AppPage(page).goto(relayUrl);
		const bar = page.getByTestId("session-bar");
		const overflowButton = page.getByTestId("session-bar-island-overflow");
		const titleChevron = page.getByTestId("session-bar-title-menu");
		const menu = page.getByTestId("session-bar-island-menu");
		const before = await bar.boundingBox();
		await expect(overflowButton).toBeVisible();
		await overflowButton.click();
		await expect(menu).toBeVisible();
		const sheet = await menu.boundingBox();
		expect(sheet).not.toBeNull();
		expect(
			Math.abs((sheet?.y ?? 0) + (sheet?.height ?? 0) - 852),
		).toBeLessThanOrEqual(1);
		expect(sheet?.x).toBe(0);
		expect(sheet?.width).toBe(393);
		await expect(page.getByTestId("menu-sheet-scrim")).toBeVisible();
		await expect(bar).toHaveAttribute("data-collapsed", "false");
		expect(await bar.boundingBox()).toEqual(before);
		const items = menu.getByRole("menuitemradio");
		await expect(items.nth(0)).toContainText("Chat");
		await expect(items.nth(1)).toContainText("Terminal");
		await expect(items.nth(2)).toContainText("Diff");
		await expect(items.nth(3)).toContainText("Files");
		await expect(items.nth(2)).toHaveAttribute("aria-disabled", "true");
		await expect(items.nth(0)).toHaveAttribute("aria-checked", "true");
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(overflowButton).toBeFocused();
		await overflowButton.click();
		await expect(page.getByTestId("menu-sheet-scrim")).not.toHaveClass(
			/pointer-events-none/,
		);
		await page.mouse.click(20, 200);
		await expect(menu).toBeHidden();

		await titleChevron.click();
		const titleMenu = page.getByTestId("session-action-sheet");
		await expect(titleMenu).toBeVisible();
		await expect(titleMenu.getByTestId("session-ctx-settle")).toBeVisible();
		await expect(titleMenu.locator(".shortcut-hint").first()).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(titleMenu).toBeHidden();
		await expect(titleChevron).toBeFocused();
		await titleChevron.click();
		await titleMenu.getByTestId("session-title-settings").click();
		await expect(page.locator("#settings-panel")).toBeVisible();
		await page.getByTestId("settings-close-btn").click();

		await overflowButton.click();
		await menu.getByRole("menuitemradio", { name: "Terminal" }).click();
		await expect(page.locator("#terminal-panel")).toBeVisible();
		await expect(menu).toBeHidden();
		// The new terminal focuses itself when its tab mounts, which can land
		// before or after the menu hands focus back (conduit-test-pgis race),
		// so the contract is only that focus is never dropped.
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						document.activeElement?.id === "session-bar-more" ||
						document
							.getElementById("terminal-panel")
							?.contains(document.activeElement) === true,
				),
			)
			.toBe(true);
		await overflowButton.click();
		await menu.getByRole("menuitemradio", { name: "Chat" }).click();
		const messages = page.locator("#messages");
		await messages.evaluate((element) => {
			const spacer = document.createElement("div");
			spacer.style.height = "1200px";
			element.firstElementChild?.append(spacer);
		});
		await page.evaluate(() => new Promise(requestAnimationFrame));
		await messages.evaluate((element) => {
			element.scrollTop = 180;
			element.dispatchEvent(new Event("scroll"));
		});
		await expect(page.locator("#messages #scroll-btn")).toBeVisible();
		await messages.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await messages.evaluate((element) => {
			element.scrollTop = Math.max(0, element.scrollTop - 400);
		});
		await expect(page.locator("#messages #scroll-btn")).toBeVisible();
		await messages.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(bar).toHaveAttribute("data-collapsed", "true");
		const collapsedBefore = await bar.boundingBox();
		await expect(overflowButton).toBeVisible();
		await overflowButton.click();
		const overflowMenu = page.getByTestId("session-bar-island-menu");
		await expect(
			overflowMenu.getByRole("menuitemradio", { name: "Chat" }),
		).toBeVisible();
		await expect(
			overflowMenu.getByRole("menuitemradio", { name: "Files" }),
		).toBeVisible();
		await expect(bar).toHaveAttribute("data-collapsed", "true");
		expect(await bar.boundingBox()).toEqual(collapsedBefore);
	});

	test("mobile: title menu settles, renames, and opens chrome actions", async ({
		page,
		relayUrl,
	}) => {
		await page.setViewportSize({ width: 393, height: 852 });
		await new AppPage(page).goto(relayUrl);
		const trigger = page.getByTestId("session-bar-title-menu");
		const sheet = page.getByTestId("session-action-sheet");
		await trigger.click();
		await sheet.getByTestId("session-ctx-settle").click();
		await expect(
			page.getByRole("status").filter({ hasText: "Moved “" }),
		).toBeVisible();
		await page.getByTestId("toast-action").click();
		await trigger.click();
		await sheet.getByTestId("session-ctx-rename").click();
		const input = page.getByRole("textbox", { name: "Session name" });
		await expect(input).toBeFocused();
		await input.fill("Renamed from title menu");
		await input.press("Enter");
		await expect(page.getByTestId("session-bar-title")).toContainText(
			"Renamed from title menu",
		);
		await page.reload();
		await expect(page.getByTestId("session-bar-title")).toContainText(
			"Renamed from title menu",
		);
		await trigger.click();
		await sheet.getByTestId("session-title-share").click();
		await expect(
			page.getByRole("heading", { name: "Share Session" }),
		).toBeVisible();
		await page.keyboard.press("Escape");
		await trigger.click();
		await sheet.getByTestId("session-title-settings").click();
		await expect(page.locator("#settings-panel")).toBeVisible();
	});

	test("mobile: debug flag adds the title menu Debug action", async ({
		page,
		relayUrl,
	}) => {
		await page.setViewportSize({ width: 393, height: 852 });
		const url = new URL(relayUrl);
		url.searchParams.set("feats", "debug");
		await new AppPage(page).goto(url.toString());
		const panel = page.locator(".debug-panel");
		await expect(panel).toBeVisible();
		await panel.getByTitle("Close panel").click();
		await expect(panel).toBeHidden();
		await page.getByTestId("session-bar-title-menu").click();
		const debug = page.getByTestId("session-title-debug");
		await expect(debug).toBeVisible();
		await debug.click();
		await expect(panel).toBeVisible();
	});

	test("mobile: session views switch without losing transcript or files position", async ({
		page,
		relayUrl,
	}) => {
		await page.setViewportSize({ width: 393, height: 852 });
		await new AppPage(page).goto(relayUrl);
		const overflowButton = page.getByTestId("session-bar-island-overflow");
		const sheet = page.getByTestId("session-bar-island-menu");
		await expect(page.getByTestId("session-bar-views-button")).toHaveCount(0);
		await expect(page.locator("#session-bar-views")).toHaveCount(0);
		await overflowButton.click();
		const items = sheet.getByRole("menuitemradio");
		await expect(items).toHaveCount(4);
		for (const name of ["Chat", "Terminal", "Diff", "Files"]) {
			await expect(sheet.getByRole("menuitemradio", { name })).toBeVisible();
		}
		const chat = page.getByTestId("overflow-view-chat");
		const terminal = page.getByTestId("overflow-view-terminal");
		const files = page.getByTestId("overflow-view-files");
		await expect(chat).toHaveAttribute("aria-checked", "true");
		await expect(page.getByTestId("overflow-view-diff")).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		for (const item of await items.all()) {
			expect((await item.boundingBox())?.height).toBeGreaterThanOrEqual(44);
		}
		await page.keyboard.press("Escape");

		const messages = page.locator("#messages");
		await messages.evaluate((element) => {
			const probe = document.createElement("div");
			probe.dataset["testid"] = "transcript-position-probe";
			probe.style.height = "1px";
			probe.style.marginTop = "360px";
			element.firstElementChild?.prepend(probe);
			const spacer = document.createElement("div");
			spacer.style.height = "1200px";
			element.firstElementChild?.append(spacer);
			element.scrollTop = 180;
		});
		const scrollTop = await messages.evaluate((element) => element.scrollTop);
		expect(scrollTop).toBeGreaterThan(0);
		const probe = page.getByTestId("transcript-position-probe");
		const probeBefore = await probe.boundingBox();
		await overflowButton.click();
		await terminal.click();
		await expect(sheet).toBeHidden();
		await expect(page.locator("#terminal-panel")).toBeVisible();
		await overflowButton.click();
		await expect(terminal).toHaveAttribute("aria-checked", "true");
		await chat.click();
		await expect(messages).toBeVisible();
		const probeAfter = await probe.boundingBox();
		expect(probeBefore && probeAfter).not.toBeNull();
		expect(
			Math.abs((probeAfter?.y ?? 0) - (probeBefore?.y ?? 0)),
		).toBeLessThanOrEqual(1);

		await overflowButton.click();
		await files.click();
		await expect(page.locator("#sidebar-panel-files")).toBeVisible();
		const folder = page
			.locator("#sidebar-panel-files .fb-entry[aria-expanded]")
			.first();
		await expect(folder).toBeVisible();
		await folder.click();
		await expect(folder).toHaveAttribute("aria-expanded", "true");
		await overflowButton.click();
		await chat.click();
		await overflowButton.click();
		await files.click();
		await expect(folder).toHaveAttribute("aria-expanded", "true");

		await overflowButton.click();
		await chat.click();
		await page.setViewportSize({ width: 320, height: 852 });
		await expect(overflowButton).toBeVisible();
		await overflowButton.click();
		await expect(sheet.getByRole("menuitemradio")).toHaveCount(4);
		await page.keyboard.press("Escape");
		expect(
			(await page.getByTestId("session-bar-title").boundingBox())?.width,
		).toBeGreaterThanOrEqual(110);
		expect(
			await page
				.getByTestId("session-bar")
				.evaluate((element) => element.scrollWidth),
		).toBeLessThanOrEqual(
			await page
				.getByTestId("session-bar")
				.evaluate((element) => element.clientWidth),
		);
		await messages.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await messages.evaluate((element) => {
			element.scrollTop = Math.max(0, element.scrollTop - 400);
		});
		await messages.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(page.getByTestId("session-bar")).toHaveAttribute(
			"data-collapsed",
			"true",
		);
		await expect(overflowButton).toBeVisible();
	});

	test("mobile: long-title two-row bar switches views at 390px", async ({
		page,
		relayUrl,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await new AppPage(page).goto(relayUrl);
		const bar = page.getByTestId("session-bar");
		const overflowButton = page.getByTestId("session-bar-island-overflow");
		const sheet = page.getByTestId("session-bar-island-menu");
		const titleMenuButton = page.getByTestId("session-bar-title-menu");
		await titleMenuButton.click();
		const actions = page.getByTestId("session-action-sheet");
		await expect(actions.locator(".shortcut-hint").first()).toBeVisible();
		await actions.getByTestId("session-ctx-rename").click();
		const longTitle =
			"Investigate the long running terminal session across every project";
		await page.getByRole("textbox", { name: "Session name" }).fill(longTitle);
		await page.getByRole("textbox", { name: "Session name" }).press("Enter");
		await expect(page.getByTestId("session-bar-title")).toContainText(
			longTitle,
		);
		const backBox = await page.getByTestId("session-bar-back").boundingBox();
		const titleBox = await page.getByTestId("session-bar-title").boundingBox();
		const hitTarget = await overflowButton.evaluate((button) => {
			const box = button.getBoundingClientRect();
			const target = getComputedStyle(button, "::before");
			const width = Number.parseFloat(target.width);
			const height = Number.parseFloat(target.height);
			return {
				width,
				height,
				left: box.left + (box.width - width) / 2,
				right: box.right + (width - box.width) / 2,
			};
		});
		expect(backBox && titleBox && titleBox.y > backBox.y).toBeTruthy();
		expect(hitTarget.height).toBeGreaterThanOrEqual(44);
		expect(hitTarget.width).toBeGreaterThanOrEqual(44);
		expect(hitTarget.left).toBeGreaterThanOrEqual(0);
		expect(hitTarget.right).toBeLessThanOrEqual(390);
		await expect(page.locator("#session-bar-views")).toHaveCount(0);
		await expect(page.getByTestId("session-bar-overflow")).toHaveCount(0);

		await overflowButton.click();
		const chat = page.getByTestId("overflow-view-chat");
		await expect(chat).toHaveAttribute("role", "menuitemradio");
		await expect(chat).toHaveAttribute("aria-checked", "true");
		await expect(page.getByTestId("overflow-view-diff")).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		for (const view of ["terminal", "files", "chat"] as const) {
			await page.getByTestId(`overflow-view-${view}`).click();
			await expect(sheet).toBeHidden();
			await overflowButton.click();
			await expect(page.getByTestId(`overflow-view-${view}`)).toHaveAttribute(
				"aria-checked",
				"true",
			);
		}
		await page.keyboard.press("Escape");
		const messages = page.locator("#messages");
		await messages.evaluate((element) => {
			const spacer = document.createElement("div");
			spacer.style.height = "1200px";
			element.firstElementChild?.append(spacer);
			element.scrollTop = element.scrollHeight;
		});
		await messages.evaluate((element) => {
			element.scrollTop = Math.max(0, element.scrollTop - 400);
		});
		await expect(page.locator("#messages #scroll-btn")).toBeVisible();
		await messages.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(bar).toHaveAttribute("data-collapsed", "true");
		await expect(overflowButton).toBeVisible();
		await expect(page.getByTestId("session-bar-views-button")).toHaveCount(0);
	});

	test("mobile: visible list and projects controls have 44px touch targets", async ({
		page,
		relayUrl,
	}) => {
		await page.setViewportSize({ width: 393, height: 852 });
		await new AppPage(page).goto(new URL("/", relayUrl).toString());
		await expect(
			page.locator("#session-list .session-item").first(),
		).toBeVisible();

		const selector =
			'a, button, input, select, [role="button"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [tabindex="0"]';
		const failures: string[] = [];
		async function measure(scope: string) {
			const controls = page.locator(scope).locator(selector);
			for (const control of await controls.all()) {
				if (!(await control.isVisible())) continue;
				const label = (await control.innerText().catch(() => "")).trim();
				const name =
					((await control.getAttribute("data-testid")) ??
						(await control.getAttribute("aria-label")) ??
						(await control.getAttribute("title")) ??
						(label || (await control.getAttribute("id")))) ||
					"unnamed control";
				const box = await control.boundingBox();
				if (!box) {
					failures.push(`${name}: visible without a bounding box (${scope})`);
					continue;
				}
				// A touchTarget control paints small and takes the tap on a
				// transparent ::before, which boundingBox() cannot see.
				const hit = await control.evaluate((element) => {
					const before = getComputedStyle(element, "::before");
					return before.position === "absolute" && before.content !== "none"
						? {
								width: Number.parseFloat(before.width),
								height: Number.parseFloat(before.height),
							}
						: { width: 0, height: 0 };
				});
				const width = Math.max(box.width, hit.width);
				const height = Math.max(box.height, hit.height);
				if (width < 44 || height < 44) {
					failures.push(
						`${name}: ${width.toFixed(1)}x${height.toFixed(1)} (${scope})`,
					);
				}
			}
		}

		await measure("#sidebar");
		await page
			.locator("#session-list .session-item")
			.first()
			.click({ button: "right" });
		await expect(page.getByTestId("session-ctx-menu")).toBeVisible();
		await measure("[role=menu]");
		await page.getByTestId("session-ctx-rename").click();
		await expect(
			page.getByRole("textbox", { name: "Session name" }),
		).toBeVisible();
		await measure("#sidebar");
		await page.keyboard.press("Escape");
		await page.getByTestId("session-group-button").click();
		await expect(
			page.getByRole("menu", { name: "Group sessions" }),
		).toBeVisible();
		await measure("[role=menu]");
		await page.keyboard.press("Escape");
		await page.getByTestId("session-scope-chip").click();
		await expect(
			page.getByRole("menu", { name: "Project scope" }),
		).toBeVisible();
		await measure("[role=menu]");
		await page
			.getByRole("menuitemradio", { name: /project:e2e-replay/ })
			.click();
		await expect(
			page.getByRole("button", { name: "Clear project scope" }),
		).toBeVisible();
		await measure("#sidebar");
		await page.getByRole("button", { name: "Clear project scope" }).click();
		await page.getByTestId("session-filter-chip-needs-you").click();
		await expect(page.getByTestId("session-filter-clear")).toBeVisible();
		await measure("#sidebar");
		await page.getByTestId("session-filter-clear").click();
		await page.getByTestId("list-bar-overflow").click();
		await expect(page.getByTestId("list-overflow-select")).toBeVisible();
		await measure("[role=menu]");
		await page.keyboard.press("Escape");
		await page.getByTestId("session-scope-chip").click();
		await page.getByRole("menuitem", { name: "Add a project…" }).click();
		const addProject = page.getByRole("dialog", {
			name: "Add project",
			exact: true,
		});
		await expect(addProject).toBeVisible();
		await measure('role=dialog[name="Add project"]');
		await page.keyboard.press("Escape");
		await expect(addProject).toHaveCount(0);
		await page.getByTestId("list-bar-overflow").click();
		await page.getByTestId("list-overflow-select").click();
		await expect(
			page
				.locator("#session-list .session-list-header")
				.getByRole("button", { name: "All", exact: true }),
		).toBeVisible();
		await measure("#sidebar");
		await page
			.locator("#session-list .session-list-header")
			.getByRole("button", { name: "Done" })
			.click();
		await expect(page.locator("#file-browser-btn")).toHaveCount(0);
		await page
			.locator("#session-list .session-item")
			.first()
			.click({ button: "right" });
		await page.getByTestId("session-ctx-settle").click();
		const settledToggle = page.getByTestId("settled-shelf-toggle");
		await expect(settledToggle).toBeVisible();
		await measure("#sidebar");
		await settledToggle.click();
		await expect(
			page.locator("#settled-shelf-rows .session-item"),
		).toBeVisible();
		await measure("#sidebar");
		await page
			.locator("#settled-shelf-rows .session-item")
			.click({ button: "right" });
		await page.getByTestId("session-ctx-unsettle").click();
		await page
			.locator("#session-list .session-item")
			.first()
			.click({ button: "right" });
		await page.getByTestId("session-ctx-snooze").click();
		await page.getByTestId("snooze-option-indefinite").click();
		const snoozedToggle = page.getByTestId("snoozed-shelf-toggle");
		await expect(snoozedToggle).toBeVisible();
		await measure("#sidebar");
		await snoozedToggle.click();
		await expect(
			page.locator("#snoozed-shelf-rows .session-item"),
		).toBeVisible();
		await measure("#sidebar");

		expect(failures, failures.join("\n")).toEqual([]);
	});

	test("mobile: list bar titles the list once, with its unsettled count", async ({
		page,
		relayUrl,
	}) => {
		await new AppPage(page).goto(new URL("/", relayUrl).toString());
		await expect(
			page.locator("#session-list .session-item").first(),
		).toBeVisible();

		await expect(page.getByTestId("list-bar-title")).toHaveText(
			/^Sessions\s*\d+$/,
		);
		await expect(page.locator("#sidebar").getByText(/^sessions$/i)).toHaveCount(
			0,
		);
	});

	test("mobile: focusing search suggests the project scopes and their tokens", async ({
		page,
		relayUrl,
	}) => {
		await new AppPage(page).goto(new URL("/", relayUrl).toString());
		const search = page.getByRole("textbox", { name: "Search sessions" });
		const suggestions = page.getByTestId("session-scope-suggestions");

		await search.focus();
		await expect(suggestions).toBeVisible();
		await expect(
			suggestions.getByRole("button", { name: "All projects" }),
		).toBeVisible();

		// A half-typed token narrows the suggestions; picking one finishes it.
		await search.fill("project:e2e");
		await expect(
			suggestions.getByRole("button", { name: "All projects" }),
		).toBeHidden();
		await suggestions
			.getByRole("button", { name: /project:e2e-replay/ })
			.click();
		await expect(page).toHaveURL(/[?&]p=e2e-replay/);
		await expect(search).toHaveValue("");
		await expect(search).toBeFocused();
		await expect(
			page.getByRole("button", { name: "Clear project scope" }),
		).toBeVisible();

		// A plain search is not a scope question.
		await search.fill("auth");
		await expect(suggestions).toBeHidden();
		await search.fill("");
		await expect(suggestions).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(suggestions).toBeHidden();
		await expect(search).toBeFocused();
	});

	test("mobile: root route shows the session list full screen", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		// The harness URL opens a session; the list is the root route.
		await app.goto(new URL("/", relayUrl).toString());

		await expect(page).toHaveURL((url) => url.pathname === "/");
		await expect(app.layout).toHaveClass(/layout-compact/);
		await expect(app.layout).toHaveClass(/phone-list-screen/);
		await expect(app.sidebar).toBeVisible();
		await expect(app.sessionsPanel).toBeVisible();
		await expect(app.app).toBeHidden();
	});

	test("mobile: selecting a session shows the session route", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		// The harness URL opens a session; the list is the root route.
		await app.goto(new URL("/", relayUrl).toString());
		const session = page.locator("#session-list .session-item").first();
		await expect(session).toBeVisible({ timeout: 10_000 });

		await session.click();
		await expect(page).toHaveURL((url) => url.pathname.startsWith("/s/"));
		await expect(app.layout).not.toHaveClass(/phone-list-screen/);
		await expect(app.sidebar).toBeHidden();
		await expect(app.app).toBeVisible();
		await expect(app.sessionBarBack).toBeVisible();
	});

	test("mobile: back returns to the list with its scroll position", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		// The harness URL opens a session; the list is the root route.
		await app.goto(new URL("/", relayUrl).toString());
		const session = page.locator("#session-list .session-item").first();
		await expect(session).toBeVisible({ timeout: 10_000 });

		await app.sessionListScroller.evaluate((element) => {
			const spacer = document.createElement("div");
			spacer.style.height = "1000px";
			element.append(spacer);
			element.scrollTop = 160;
		});
		await expect
			.poll(() =>
				app.sessionListScroller.evaluate((element) => element.scrollTop),
			)
			.toBe(160);

		await session.evaluate((element: HTMLElement) => element.click());
		await expect(app.sessionBarBack).toBeVisible();
		await app.sessionListScroller.evaluate((element) => {
			element.scrollTop = 0;
		});
		await app.sessionBarBack.click();

		await expect(page).toHaveURL((url) => url.pathname === "/");
		await expect(app.sessionsPanel).toBeVisible();
		await expect
			.poll(() =>
				app.sessionListScroller.evaluate((element) => element.scrollTop),
			)
			.toBe(160);
	});
});
