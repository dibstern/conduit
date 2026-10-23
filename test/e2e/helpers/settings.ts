import { expect, type Locator, type Page } from "@playwright/test";

/** Return through the phone settings pages before using Done. */
export async function closeSettings(page: Page): Promise<void> {
	const surfacingBack = page.getByRole("button", {
		name: "Back to Jev",
		exact: true,
	});
	if (await surfacingBack.isVisible()) await surfacingBack.click();
	const sectionBack = page.getByTestId("settings-back-btn");
	if (await sectionBack.isVisible()) await sectionBack.click();
	await page
		.getByRole("button", { name: "Close settings", exact: true })
		.click();
}

export async function chooseSettingsOption(
	page: Page,
	trigger: Locator,
	option: string | { label: string },
): Promise<void> {
	await trigger.click();
	const menuId = await trigger.getAttribute("aria-controls");
	if (!menuId) throw new Error("Settings picker did not identify its menu");
	const menu = page.locator(`[id=${JSON.stringify(menuId)}]`);
	await expect(menu).toBeVisible();
	const items = menu.getByRole("menuitemradio");
	await (typeof option === "string"
		? items.and(page.locator(`[data-value=${JSON.stringify(option)}]`))
		: menu.getByRole("menuitemradio", { name: option.label, exact: true })
	).click();
	await expect(menu).toBeHidden();
}
