import type { Locator, Page } from "@playwright/test";

export class PinPage {
	readonly page: Page;
	readonly pinInput: Locator;
	readonly errorMessage: Locator;
	readonly heading: Locator;
	readonly subtitle: Locator;

	constructor(page: Page) {
		this.page = page;
		this.pinInput = page.locator("#pin");
		this.errorMessage = page.locator("#err");
		this.heading = page.locator("h1");
		this.subtitle = page.locator(".sub");
	}

	async goto(baseUrl: string): Promise<void> {
		await this.page.goto(baseUrl);
	}

	async isVisible(): Promise<boolean> {
		try {
			await this.pinInput.waitFor({ state: "visible", timeout: 2_000 });
			return true;
		} catch {
			return false;
		}
	}

	async enterPin(pin: string): Promise<void> {
		await this.pinInput.fill(pin);
	}
}
