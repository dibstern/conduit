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

/**
 * Opens the phone Composer sheet, where the checkout row and its workspace
 * notices live. A sheet that is already open stays open.
 */
export async function openComposerSheet(page: Page): Promise<void> {
	const sheet = page.getByTestId("composer-more-sheet");
	if (!(await sheet.isVisible()))
		await page.getByRole("button", { name: /^Composer options:/ }).click();
	await expect(sheet).toBeVisible();
}
