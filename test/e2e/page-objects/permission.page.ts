import type { Locator, Page } from "@playwright/test";

export class PermissionPage {
	readonly page: Page;
	readonly cards: Locator;

	constructor(page: Page) {
		this.page = page;
		this.cards = page.locator(".permission-card");
	}

	async waitForCard(timeout?: number): Promise<Locator> {
		const card = this.cards.last();
		await card.waitFor({ state: "visible", timeout: timeout ?? 30_000 });
		return card;
	}

	async clickAllow(): Promise<void> {
		const card = this.cards.last();
		await card.locator("button", { hasText: /^Allow$/ }).click();
	}

	async clickDeny(): Promise<void> {
		const card = this.cards.last();
		await card.locator("button", { hasText: "Deny" }).click();
	}

	/** Click "Always Allow" — defaults to tool-level if options expand */
	async clickAlwaysAllow(): Promise<void> {
		const card = this.cards.last();
		await card.locator("button", { hasText: /^Always Allow/ }).click();
		// If options appeared, click "All ... operations" (tool-level)
		const toolOption = card.locator("button", {
			hasText: /^All .+ operations$/,
		});
		if (await toolOption.isVisible({ timeout: 1000 }).catch(() => false)) {
			await toolOption.click();
		}
	}

	/** Click a specific pattern option from the "Always Allow" expansion */
	async clickAlwaysAllowPattern(pattern: string): Promise<void> {
		const card = this.cards.last();
		await card.locator("button", { hasText: /^Always Allow/ }).click();
		const patternBtn = card.locator("button", { hasText: pattern });
		await patternBtn.click();
	}

	async getCardCount(): Promise<number> {
		return this.cards.count();
	}
}
