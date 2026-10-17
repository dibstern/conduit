import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Opens the model picker at its root, where the harness, account, model and
 * effort rows live. The desktop chip opens it directly; phones first open the
 * Composer sheet.
 */
export async function openPickerRoot(
	page: Page,
	trigger: Locator,
): Promise<void> {
	await trigger.click();
	if (
		(await trigger.getAttribute("aria-label"))?.startsWith("Composer options:")
	)
		await page.getByTestId("composer-harness-trigger").click();
	await expect(page.getByTestId("model-picker")).toBeVisible();
	const back = page.getByTestId("picker-back");
	if (await back.isVisible()) await back.click();
}
