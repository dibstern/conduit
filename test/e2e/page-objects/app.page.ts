import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { ProcessHarness } from "../../helpers/process-harness.js";

export class AppPage {
	readonly page: Page;

	// Session bar
	readonly statusDot: Locator;
	readonly sidebarExpandBtn: Locator;
	readonly terminalToggleBtn: Locator;
	readonly moreActionsBtn: Locator;
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
	readonly checkout: Locator;
	readonly input: Locator;
	readonly sendBtn: Locator;
	readonly attachBtn: Locator;

	// Messages
	readonly messages: Locator;
	readonly scrollBtn: Locator;

	// Other
	readonly todoSticky: Locator;
	readonly commandMenu: Locator;
	readonly bannerContainer: Locator;

	constructor(page: Page) {
		this.page = page;
		this.statusDot = page.locator("#session-bar #status");
		this.sidebarExpandBtn = page.getByTestId("session-bar-back");
		this.terminalToggleBtn = page.getByTestId("views-rail-terminal");
		this.moreActionsBtn = page.getByTestId("session-bar-overflow");
		this.qrBtn = page.getByTestId("overflow-share");
		this.notifSettingsBtn = page.locator("#notif-settings-btn");
		this.clientCountBadge = page.locator("#client-count-badge");
		this.layout = page.locator("#layout");
		this.sidebar = page.locator("#sidebar");
		this.sessionsPanel = page.locator("#sidebar-panel-sessions");
		this.sessionListScroller = page.locator("#session-list-scroller");
		this.sessionBarBack = page.locator("[data-testid='session-bar-back']");
		this.app = page.locator("#layout #app");
		this.connectOverlay = page.locator("#connect-overlay");
		this.checkout = page.getByTestId("composer-checkout");
		this.input = page.locator("#input");
		this.sendBtn = page.locator("#send");
		this.attachBtn = page.locator("#attach-btn");
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

	/** A cold empty load opens setup; removing the last project keeps settings available. */
	async mountWithoutProjects(
		harness: ProcessHarness,
		mount: () => Promise<void> = () => this.goto(harness.baseUrl),
	): Promise<void> {
		const project = await harness.requestRpc({
			_tag: "SaveProject",
			title: "Settings fixture",
			folders: [harness.projectDir],
		});
		try {
			await mount();
			await expect(
				this.page
					.locator('.session-empty, [data-testid="project-tree-empty"]')
					.first(),
			).toBeVisible();
		} finally {
			await harness.requestRpc({
				_tag: "RemoveProject",
				slug: project.savedSlug,
			});
		}
		expect(
			(await harness.requestRpc({ _tag: "GetProjects" })).projects,
		).toEqual([]);
		await expect(this.page.getByTestId("project-tree-header")).toHaveCount(0);
	}

	async waitForConnected(): Promise<void> {
		await expect(this.statusDot).toHaveClass(/bg-success/, {
			timeout: 10_000,
		});
	}

	async sendMessage(text: string): Promise<void> {
		await this.input.fill(text);
		// Send also waits for the session to be placed, which can lag goto()
		// under load, so this takes the default expect timeout.
		await expect(this.sendBtn).toBeEnabled();
		await this.sendBtn.click();
	}

	/** Pick a draft's project in its chip; the phone sheet opens on a tap. */
	async chooseDraftProject(title: string): Promise<void> {
		const chip = this.page.getByTestId("draft-project-chip");
		if (await this.isMobileViewport()) await chip.tap();
		else await chip.click();
		await this.page.getByRole("menuitemradio", { name: title }).click();
		await expect(chip).toContainText(title);
	}

	async isMobileViewport(): Promise<boolean> {
		const viewport = this.page.viewportSize();
		return viewport ? viewport.width < 769 : false;
	}
}
