// Tests session CRUD via the sidebar: create, switch, search.
// Uses real relay backed by MockOpenCodeServer.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({ recording: "chat-simple" });

test.describe("Session Management", () => {
	test("new session opens it while another session is open", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const sidebar = new SidebarPage(page);
		await app.goto(relayUrl);
		await sidebar.waitForSessions();

		const current = await sidebar.sessionList
			.locator("[data-session-id]")
			.first()
			.getAttribute("data-session-id");
		if (!current) throw new Error("expected a session in the list");
		await sidebar.clickSession(current);
		await expect(page).toHaveURL(new RegExp(`/s/${current}$`));

		const countBefore = await sidebar.getSessionCount();
		await sidebar.createNewSession();
		await expect(page).not.toHaveURL(new RegExp(`/s/${current}$`));
		await expect(page).toHaveURL(/\/s\/[^/]+$/);
		await expect
			.poll(() => sidebar.getSessionCount())
			.toBeGreaterThan(countBefore);
	});

	test("search sessions filters the list", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		const sidebar = new SidebarPage(page);
		await app.goto(relayUrl);

		// Wait for sessions to render (auto-retrying, avoids race with WS data)
		await sidebar.waitForSessions();
		const countBefore = await sidebar.getSessionCount();
		expect(countBefore).toBeGreaterThan(0);

		// Toggle search and enter a query that won't match anything
		await sidebar.searchSessions(`zzz_no_match_ever_${Date.now()}`);

		// Wait for the filter to apply — session count should drop to 0
		await expect(page.locator("#session-list .session-item")).toHaveCount(0, {
			timeout: 5_000,
		});

		const filtered = await sidebar.getSessionCount();
		expect(filtered).toBe(0);
	});

	test("new session lives in the sidebar header, not an action list", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const sidebar = new SidebarPage(page);
		await app.goto(relayUrl);

		await expect(
			page.locator("#sidebar-header #new-session-btn"),
		).toBeVisible();
		await expect(
			page.locator("#new-session-btn .lucide-square-pen"),
		).toHaveCount(1);
		await expect(page.locator("#session-actions")).toHaveCount(0);
		await expect(page.locator("#file-browser-btn")).toHaveCount(0);
		await expect(sidebar.sessionList).toBeVisible();
	});

	test("Files pane opens and closes beside sessions", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const sidebar = new SidebarPage(page);
		await app.goto(relayUrl);

		await expect(sidebar.sessionsPanel).toBeVisible();
		const files = page.getByTestId("views-rail-files");
		await files.click();
		await expect(page.getByTestId("side-pane-files")).toBeVisible();
		await expect(sidebar.sessionsPanel).toBeVisible();
		await files.click();
		await expect(page.getByTestId("side-pane-files")).toBeHidden();
	});
});
