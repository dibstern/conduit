import { expect, type Locator, type Page } from "@playwright/test";

export class SidebarPage {
	readonly page: Page;
	readonly sidebar: Locator;
	readonly sessionList: Locator;
	readonly newSessionBtn: Locator;
	readonly resumeSessionBtn: Locator;
	readonly fileBrowserBtn: Locator;
	readonly terminalBtn: Locator;
	readonly searchBtn: Locator;
	readonly searchInput: Locator;
	readonly searchContainer: Locator;
	readonly fileTree: Locator;
	readonly sessionsPanel: Locator;
	readonly filesPanel: Locator;
	readonly subagentToggleBtn: Locator;

	constructor(page: Page) {
		this.page = page;
		this.sidebar = page.locator("#sidebar");
		this.sessionList = page.locator("#session-list");
		this.newSessionBtn = page.locator("#new-session-btn");
		this.resumeSessionBtn = page.locator("#resume-session-btn");
		this.fileBrowserBtn = page.locator("#file-browser-btn");
		this.terminalBtn = page.locator("#terminal-sidebar-btn");
		this.searchBtn = page.locator("#search-session-btn");
		this.searchInput = page.locator("#session-search-input");
		this.searchContainer = page.locator("#session-search");
		this.fileTree = page.locator("#file-tree");
		this.sessionsPanel = page.locator("#sidebar-panel-sessions");
		this.filesPanel = page.locator("#sidebar-panel-files");
		this.subagentToggleBtn = page.locator('[data-testid="subagent-toggle"]');
	}

	async getSessionItems(): Promise<Locator> {
		return this.sessionList.locator(".session-item");
	}

	async getSessionCount(): Promise<number> {
		return this.sessionList.locator(".session-item").count();
	}

	async clickSession(id: string): Promise<void> {
		await this.sessionList.locator(`[data-session-id="${id}"]`).click();
	}

	async createNewSession(): Promise<void> {
		await this.newSessionBtn.click();
	}

	async toggleSearch(): Promise<void> {
		await this.searchBtn.click();
	}

	async searchSessions(query: string): Promise<void> {
		await this.searchBtn.click();
		await this.searchInput.fill(query);
	}

	async openContextMenu(sessionId: string): Promise<void> {
		const item = this.sessionList.locator(`[data-session-id="${sessionId}"]`);
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

	async openFilePanel(): Promise<void> {
		await this.fileBrowserBtn.click();
	}

	async closeFilePanel(): Promise<void> {
		await this.fileBrowserBtn.click();
	}
}
