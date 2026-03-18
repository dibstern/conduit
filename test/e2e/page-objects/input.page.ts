import type { Locator, Page } from "@playwright/test";

export class InputPage {
	readonly page: Page;
	readonly textarea: Locator;
	readonly sendBtn: Locator;
	readonly attachBtn: Locator;
	readonly attachMenu: Locator;
	readonly contextMini: Locator;
	readonly contextFill: Locator;
	readonly contextLabel: Locator;

	constructor(page: Page) {
		this.page = page;
		this.textarea = page.locator("#input");
		this.sendBtn = page.locator("#send");
		this.attachBtn = page.locator("#attach-btn");
		this.attachMenu = page.locator("#attach-menu");
		this.contextMini = page.locator("#context-mini");
		this.contextFill = page.locator("#context-mini-fill");
		this.contextLabel = page.locator("#context-mini-label");
	}

	async type(text: string): Promise<void> {
		await this.textarea.fill(text);
	}

	async send(): Promise<void> {
		await this.sendBtn.click();
	}

	async isStopMode(): Promise<boolean> {
		const classes = (await this.sendBtn.getAttribute("class")) ?? "";
		return classes.includes("stop");
	}

	async openAttachMenu(): Promise<void> {
		await this.attachBtn.click();
	}

	async isAttachMenuVisible(): Promise<boolean> {
		return !(await this.attachMenu.evaluate((el) =>
			el.classList.contains("hidden"),
		));
	}

	async pressEnter(): Promise<void> {
		await this.textarea.press("Enter");
	}

	async pressShiftEnter(): Promise<void> {
		await this.textarea.press("Shift+Enter");
	}
}
