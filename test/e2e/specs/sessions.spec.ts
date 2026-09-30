// ─── E2E Session Management Tests ────────────────────────────────────────────
// Tests session CRUD via the sidebar: create, switch, search.
// Uses real relay backed by MockOpenCodeServer.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({ recording: "chat-simple" });

test.describe("Session Management", () => {
	test("session list is populated on page load", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		const sidebar = new SidebarPage(page);
		await app.goto(relayUrl);

		// Wait for sessions to render (auto-retrying, avoids race with WS data)
		await sidebar.waitForSessions();
		const count = await sidebar.getSessionCount();
		expect(count).toBeGreaterThan(0);
	});

	test("create new session via sidebar button", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		const sidebar = new SidebarPage(page);
		await app.goto(relayUrl);

		// Wait for sessions to render before counting
		await sidebar.waitForSessions();
		const countBefore = await sidebar.getSessionCount();

		// Click "New session" button
		await sidebar.createNewSession();

		// Wait for the session to be created (session list updates via SSE)
		// The relay calls POST /session on the mock and updates the frontend
		await page.waitForFunction(
			(prev) => {
				const items = document.querySelectorAll("#session-list .session-item");
				return items.length > prev;
			},
			countBefore,
			{ timeout: 10_000 },
		);

		const countAfter = await sidebar.getSessionCount();
		expect(countAfter).toBeGreaterThan(countBefore);
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

	test("action buttons are visible in sidebar", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		const sidebar = new SidebarPage(page);
		await app.goto(relayUrl);

		// All action buttons should be present
		await expect(sidebar.newSessionBtn).toBeVisible();
		await expect(sidebar.resumeSessionBtn).toBeVisible();
		await expect(page.locator("#file-browser-btn")).toHaveCount(0);
		await expect(sidebar.terminalBtn).toBeVisible();
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
