import type { Locator, Page } from "@playwright/test";

export class DashboardPage {
	readonly page: Page;
	readonly heading: Locator;
	readonly subtitle: Locator;
	readonly projectCards: Locator;
	readonly emptyMessage: Locator;

	constructor(page: Page) {
		this.page = page;
		this.heading = page.locator("h1");
		this.subtitle = page.locator(".subtitle");
		this.projectCards = page.locator(".card");
		this.emptyMessage = page.locator(".empty");
	}

	async goto(baseUrl: string): Promise<void> {
		await this.page.goto(baseUrl);
	}

	async getProjectCount(): Promise<number> {
		return this.projectCards.count();
	}

	async getHeadingText(): Promise<string> {
		return this.heading.innerText();
	}
}
