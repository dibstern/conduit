import { expect, type Locator, type Page } from "@playwright/test";

export async function chooseSettingsOption(
	page: Page,
	trigger: Locator,
	option: string | { label: string },
): Promise<void> {
	await trigger.click();
	const items = page.getByRole("menuitemradio");
	await (typeof option === "string"
		? items.and(page.locator(`[data-value=${JSON.stringify(option)}]`))
		: page.getByRole("menuitemradio", { name: option.label, exact: true })
	).click();
	await expect(page.getByRole("menu")).toBeHidden();
}
