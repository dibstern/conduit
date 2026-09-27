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
	test.use({ viewport: { width: 375, height: 667 }, persistence: true });

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
		await page.getByRole("button", { name: "Cleanup sessions" }).click();
		await expect(
			page.getByRole("button", { name: "Select all" }),
		).toBeVisible();
		await measure("#sidebar");
		await page
			.locator("#session-list .session-list-header")
			.getByRole("button", { name: "Cancel" })
			.click();
		await page.locator("#file-browser-btn").click();
		await expect(page.locator("#sidebar-panel-files")).toBeVisible();
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
