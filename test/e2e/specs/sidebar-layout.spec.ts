// ─── E2E Sidebar Layout Tests ────────────────────────────────────────────────
// Tests responsive sidebar behavior across viewports:
// - Desktop: sidebar visible, collapse/expand toggle
// - Mobile: hamburger menu, sidebar overlay, backdrop close
// Uses real relay backed by MockOpenCodeServer.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

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

	test("mobile: sidebar is hidden by default", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// On mobile, sidebar overlay should be hidden by default
		await expect(app.sidebarOverlay).toBeHidden();

		// Hamburger button should be visible
		await expect(app.hamburgerBtn).toBeVisible();
	});

	test("mobile: hamburger opens sidebar overlay", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Open sidebar
		await app.hamburgerBtn.click();

		// Sidebar overlay should be visible
		await expect(app.sidebarOverlay).toBeVisible();

		// Session list should be accessible
		const sessionList = page.locator("#session-list");
		await expect(sessionList).toBeVisible();
	});

	test("mobile: tapping overlay closes sidebar", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Open sidebar
		await app.hamburgerBtn.click();
		await expect(app.sidebarOverlay).toBeVisible();

		// Tap the overlay to close
		await app.sidebarOverlay.click({ force: true });

		// Sidebar overlay should be hidden again
		await expect(app.sidebarOverlay).toBeHidden();
	});

	test("header elements are appropriately visible on mobile", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Project name always visible
		await expect(app.projectName).toBeVisible();

		// Status dot always visible
		await expect(app.statusDot).toBeVisible();

		// Hamburger visible on mobile
		await expect(app.hamburgerBtn).toBeVisible();
	});
});
