import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export class AppPage {
	readonly page: Page;

	// Header
	readonly projectName: Locator;
	readonly statusDot: Locator;
	readonly sidebarExpandBtn: Locator;
	readonly terminalToggleBtn: Locator;
	readonly qrBtn: Locator;
	readonly notifSettingsBtn: Locator;
	readonly clientCountBadge: Locator;

	// Layout
	readonly layout: Locator;
	readonly sidebar: Locator;
	readonly sessionsPanel: Locator;
	readonly sessionListScroller: Locator;
	readonly sessionBarBack: Locator;
	readonly app: Locator;

	// Connection
	readonly connectOverlay: Locator;

	// Input
	readonly input: Locator;
	readonly sendBtn: Locator;
	readonly attachBtn: Locator;
	readonly contextMini: Locator;

	// Messages
	readonly messages: Locator;
	readonly scrollBtn: Locator;

	// Other
	readonly todoSticky: Locator;
	readonly commandMenu: Locator;
	readonly bannerContainer: Locator;

	constructor(page: Page) {
		this.page = page;
		this.projectName = page.locator("#project-name");
		this.statusDot = page.locator("#status");
		this.sidebarExpandBtn = page.locator("#sidebar-expand-btn");
		this.terminalToggleBtn = page.locator("#header-terminal-btn");
		this.qrBtn = page.locator("#qr-btn");
		this.notifSettingsBtn = page.locator("#notif-settings-btn");
		this.clientCountBadge = page.locator("#client-count-badge");
		this.layout = page.locator("#layout");
		this.sidebar = page.locator("#sidebar");
		this.sessionsPanel = page.locator("#sidebar-panel-sessions");
		this.sessionListScroller = page.locator("#session-list-scroller");
		this.sessionBarBack = page.locator("[data-testid='session-bar-back']");
		this.app = page.locator("#layout #app");
		this.connectOverlay = page.locator("#connect-overlay");
		this.input = page.locator("#input");
		this.sendBtn = page.locator("#send");
		this.attachBtn = page.locator("#attach-btn");
		this.contextMini = page.locator("#context-mini");
		this.messages = page.locator("#messages");
		this.scrollBtn = page.locator("#scroll-btn");
		this.todoSticky = page.locator("#todo-sticky");
		this.commandMenu = page.locator("#command-menu");
		this.bannerContainer = page.locator("#banner-container");
	}

	async goto(baseUrl: string): Promise<void> {
		await this.page.goto(baseUrl);
		// Wait for Svelte SPA to mount — layout appears on initial render.
		// Use the full test timeout (30s) — under resource pressure during
		// pnpm test:all, the SPA bundle + Svelte mount can take >15s.
		await this.layout.waitFor({ state: "attached", timeout: 30_000 });
		// Compact list routes hide all of #app, so visibility cannot prove the
		// socket connected. The overlay unmounts only after connection succeeds.
		await this.connectOverlay.waitFor({ state: "detached", timeout: 30_000 });
	}

	async waitForConnected(): Promise<void> {
		await expect(this.statusDot).toHaveClass(/bg-success/, {
			timeout: 10_000,
		});
	}

	async sendMessage(text: string): Promise<void> {
		await this.input.fill(text);
		// Fill enables the send button
		await expect(this.sendBtn).toBeEnabled({ timeout: 2_000 });
		await this.sendBtn.click();
	}

	async isMobileViewport(): Promise<boolean> {
		const viewport = this.page.viewportSize();
		return viewport ? viewport.width < 769 : false;
	}
}
