import { expect, type Locator, type Page } from "@playwright/test";

export class SidebarPage {
	readonly page: Page;
	readonly sidebar: Locator;
	readonly sessionList: Locator;
	readonly newSessionBtn: Locator;
	readonly searchInput: Locator;
	readonly searchContainer: Locator;
	readonly fileTree: Locator;
	readonly sessionsPanel: Locator;

	constructor(page: Page) {
		this.page = page;
		this.sidebar = page.locator("#sidebar");
		this.sessionList = page.locator("#session-list");
		this.newSessionBtn = page.locator("#new-session-btn");
		this.searchInput = page.locator("#session-search-input");
		this.searchContainer = page.locator("#session-search");
		this.fileTree = page.locator("#file-tree");
		this.sessionsPanel = page.locator("#sidebar-panel-sessions");
	}

	async getSessionItems(): Promise<Locator> {
		return this.sessionList.locator(".session-item");
	}

	async getSessionCount(): Promise<number> {
		return this.sessionList.locator(".session-item").count();
	}

	async clickSession(id: string): Promise<void> {
		// The row centre can land on the hover-revealed "Mark unread" button.
		await this.sessionList
			.locator(`[data-session-id="${id}"] .session-item-title`)
			.click();
	}

	/** `+` opens a draft; the session exists once its first message is sent. */
	async createNewSession(text = "New session"): Promise<void> {
		await this.newSessionBtn.click();
		await expect(this.page).toHaveURL(/\/new\?/);
		await this.page.locator("#input").fill(text);
		await this.page.locator("#send").click();
		await expect(this.page).toHaveURL(/\/s\/[^/?]+(?:\?.*)?$/);
		// The reply leaves the row done-unread, and the first touch on it later
		// regroups it under the caller. Settle it now, the way a user does, by
		// picking the row (only reachable where the list shares the screen).
		const id = new URL(this.page.url()).pathname.split("/").pop();
		const row = this.sessionList.locator(`[data-session-id="${id}"]`);
		await expect(row).toHaveAttribute("aria-label", /^Done/);
		if (!(await row.isVisible())) return;
		await row.locator(".session-item-title").click();
		await expect(row).not.toHaveAttribute("aria-label", /^Done/);
	}

	async searchSessions(query: string): Promise<void> {
		await this.searchInput.fill(query);
	}

	async openContextMenu(sessionId: string): Promise<void> {
		const item = this.sessionList.locator(`[data-session-id="${sessionId}"]`);
		await item.hover();
		await item.locator(".session-more-btn").click();
	}

	/**
	 * Wait until at least one session item is rendered in the sidebar.
	 * Uses Playwright's auto-retrying assertion to avoid race conditions
	 * between WS connection and session data rendering.
	 */
	async waitForSessions(timeout = 10_000): Promise<void> {
		await expect(this.sessionList.locator(".session-item").first()).toBeVisible(
			{
				timeout,
			},
		);
	}
}
