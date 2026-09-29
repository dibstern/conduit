// ─── E2E Sidebar Layout Tests ────────────────────────────────────────────────
// Tests responsive sidebar behavior across viewports:
// - Desktop: sidebar visible, collapse/expand toggle
// - Mobile: session list and session are separate routes
// Uses real relay backed by MockOpenCodeServer.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({ recording: "chat-simple" });

test.describe("Sidebar Layout — Desktop", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

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

	test("header elements are appropriately visible", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Project name always visible
		await expect(app.projectName).toBeVisible();

		// Status dot always visible
		await expect(app.statusDot).toBeVisible();

		// QR button always visible
		await expect(app.qrBtn).toBeVisible();
	});
});

test.describe("Sidebar Layout — Mobile", () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test("mobile: overflow and title menus use bottom sheets", async ({
		page,
		relayUrl,
	}) => {
		await page.setViewportSize({ width: 393, height: 852 });
		await new AppPage(page).goto(relayUrl);
		const bar = page.getByTestId("session-bar");
		const overflow = page.getByTestId("session-bar-overflow");
		const titleChevron = page.getByTestId("session-bar-title-menu");
		const menu = page.getByTestId("session-bar-overflow-menu");
		const before = await bar.boundingBox();
		await overflow.click();
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
		const items = menu.getByRole("menuitem");
		await expect(items.nth(0)).toContainText("Chat");
		await expect(items.nth(1)).toContainText("Terminal");
		await expect(items.nth(2)).toContainText("Diff");
		await expect(items.nth(3)).toContainText("Files");
		await expect(items.nth(2)).toHaveAttribute("aria-disabled", "true");
		await expect(items.nth(0)).toHaveAttribute("aria-current", "true");
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(overflow).toBeFocused();
		await overflow.click();
		await expect(page.getByTestId("menu-sheet-scrim")).not.toHaveClass(
			/pointer-events-none/,
		);
		await page.mouse.click(20, 200);
		await expect(menu).toBeHidden();
		await expect(overflow).toBeFocused();

		await titleChevron.click();
		const titleMenu = page.getByTestId("session-action-sheet");
		await expect(titleMenu).toBeVisible();
		await expect(titleMenu.getByTestId("session-ctx-settle")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(titleMenu).toBeHidden();
		await expect(titleChevron).toBeFocused();
		await titleChevron.click();
		await titleMenu.getByTestId("session-title-settings").click();
		await expect(page.locator("#settings-panel")).toBeVisible();
		await page.getByTestId("settings-close-btn").click();

		await overflow.click();
		await menu.getByRole("menuitem", { name: "Terminal" }).click();
		await expect(page.locator("#terminal-panel")).toBeVisible();
		await expect(menu).toBeHidden();
		// Picking Terminal moves focus into the terminal rather than back to the opener.
		await expect(
			page.getByRole("textbox", { name: "Terminal input" }),
		).toBeFocused();
		await page.getByTestId("session-view-chat").click();
		const messages = page.locator("#messages");
		await messages.evaluate((element) => {
			const spacer = document.createElement("div");
			spacer.style.height = "1200px";
			element.firstElementChild?.append(spacer);
			element.scrollTop = 180;
		});
		await expect(page.locator("#messages #scroll-btn")).toBeVisible();
		await messages.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await messages.evaluate((element) => {
			element.scrollTop = Math.max(0, element.scrollTop - 400);
		});
		await messages.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(bar).toHaveAttribute("data-collapsed", "true");
		const collapsedBefore = await bar.boundingBox();
		await overflow.click();
		await expect(menu.getByRole("menuitem", { name: "Chat" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Files" })).toBeVisible();
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
		const band = page.getByTestId("session-bar-views");
		const tabs = band.getByRole("tab");
		await expect(tabs).toHaveCount(4);
		for (const name of ["Chat", "Terminal", "Diff", "Files"]) {
			await expect(band.getByRole("tab", { name })).toBeVisible();
		}
		const chat = band.getByRole("tab", { name: "Chat" });
		const terminal = band.getByRole("tab", { name: "Terminal" });
		const files = band.getByRole("tab", { name: "Files" });
		await expect(chat).toHaveAttribute("aria-selected", "true");
		await expect(band.getByRole("tab", { name: "Diff" })).toBeDisabled();
		for (const tab of await tabs.all()) {
			expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
		}

		const messages = page.locator("#messages");
		await messages.evaluate((element) => {
			const spacer = document.createElement("div");
			spacer.style.height = "1200px";
			element.firstElementChild?.append(spacer);
			element.scrollTop = 180;
		});
		const scrollTop = await messages.evaluate((element) => element.scrollTop);
		expect(scrollTop).toBeGreaterThan(0);
		await terminal.click();
		await expect(page.locator("#terminal-panel")).toBeVisible();
		await expect(terminal).toHaveAttribute("aria-selected", "true");
		await chat.click();
		await expect(messages).toBeVisible();
		await expect(chat).toHaveAttribute("aria-selected", "true");
		expect(await messages.evaluate((element) => element.scrollTop)).toBe(
			scrollTop,
		);

		await files.click();
		await expect(page.locator("#sidebar-panel-files")).toBeVisible();
		const folder = page
			.locator("#sidebar-panel-files .fb-entry[aria-expanded]")
			.first();
		await expect(folder).toBeVisible();
		await folder.click();
		await expect(folder).toHaveAttribute("aria-expanded", "true");
		await chat.click();
		await files.click();
		await expect(folder).toHaveAttribute("aria-expanded", "true");

		await chat.click();
		await page.setViewportSize({ width: 320, height: 852 });
		await expect(tabs).toHaveCount(4);
		for (const tab of await tabs.all()) await expect(tab).toBeVisible();
		await expect(band.locator(".session-view-label").first()).toBeHidden();
		expect(
			(await page.getByTestId("session-bar-title").boundingBox())?.width,
		).toBeGreaterThanOrEqual(110);
		expect(
			await band.evaluate((element) => element.scrollWidth),
		).toBeLessThanOrEqual(
			await band.evaluate((element) => element.clientWidth),
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
		await expect(band).toHaveCount(0);
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
		await expect(page.getByTestId("list-overflow-projects")).toBeVisible();
		await measure("[role=menu]");
		await page.getByTestId("list-overflow-projects").click();
		await expect(page.getByTestId("sidebar-projects-panel")).toBeVisible();
		await measure("#sidebar-projects-panel");
		await page.getByRole("button", { name: "Add project" }).click();
		await expect(
			page.getByRole("combobox", { name: "Project directory" }),
		).toBeVisible();
		await measure("#sidebar-projects-panel");
		await page.getByRole("button", { name: "Cancel" }).click();
		await page
			.getByRole("button", { name: "More options for e2e-replay" })
			.click();
		await expect(page.getByTestId("project-ctx-menu")).toBeVisible();
		await measure("[role=menu]");
		await page.getByTestId("project-ctx-rename").click();
		await expect(
			page.getByRole("textbox", { name: "Rename project" }),
		).toBeVisible();
		await measure("#sidebar-projects-panel");
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Select sessions" }).click();
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
		await page.locator("#file-browser-btn").click();
		await expect(page.locator("#sidebar-panel-files")).toBeVisible();
		// Measure the rows, not the loading placeholder that precedes them.
		await expect(page.locator("#file-tree .fb-entry").first()).toBeVisible();
		await measure("#sidebar");
		await page.locator("#file-panel-close").click();
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

	test("mobile: list bar menu opens the projects panel", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(new URL("/", relayUrl).toString());

		await page.getByTestId("list-bar-overflow").click();
		await page.getByTestId("list-overflow-projects").click();

		// The menu is portaled outside the header, so the header's click-outside
		// dismissal must not close the panel the menu item just opened.
		await expect(page.getByTestId("sidebar-projects-panel")).toBeVisible();
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
