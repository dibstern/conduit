import type { Locator, Page } from "@playwright/test";

export class OverlayPage {
	readonly page: Page;
	readonly connectOverlay: Locator;
	readonly pixelCanvas: Locator;
	readonly connectVerb: Locator;
	readonly bannerContainer: Locator;
	readonly notifMenu: Locator;

	constructor(page: Page) {
		this.page = page;
		this.connectOverlay = page.locator("#connect-overlay");
		this.pixelCanvas = page.locator("#pixel-canvas");
		this.connectVerb = page.locator(".connect-verb");
		this.bannerContainer = page.locator("#banner-container");
		this.notifMenu = page.locator("#notif-menu");
	}

	async isOverlayVisible(): Promise<boolean> {
		return !(await this.connectOverlay.evaluate((el) =>
			el.classList.contains("hidden"),
		));
	}

	async waitForOverlayHidden(timeout?: number): Promise<void> {
		await this.connectOverlay.waitFor({
			state: "hidden",
			timeout: timeout ?? 15_000,
		});
	}

	async getVerbText(): Promise<string> {
		return this.connectVerb.innerText();
	}

	async getBannerCount(): Promise<number> {
		return this.bannerContainer.locator(".banner").count();
	}

	async isNotifMenuVisible(): Promise<boolean> {
		return !(await this.notifMenu.evaluate((el) =>
			el.classList.contains("hidden"),
		));
	}
}
