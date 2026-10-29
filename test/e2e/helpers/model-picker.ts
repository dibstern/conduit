import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Opens the model picker at its root, where the harness, account, model and
 * effort rows live. Both phone and desktop triggers open it directly.
 */
export async function openPickerRoot(
	page: Page,
	trigger: Locator,
): Promise<void> {
	await trigger.click();
	await expect(page.getByTestId("model-picker")).toBeVisible();
	const back = page.getByTestId("picker-back");
	if (await back.isVisible()) await back.click();
}

/**
 * Opens the Session panel root, where checkout notices and actions live.
 * A panel that is already open stays open.
 */
export async function openSessionPanel(page: Page): Promise<void> {
	const sheet = page.getByTestId("model-picker");
	if (!(await sheet.isVisible()))
		await page.getByRole("button", { name: /^Harness and model:/ }).click();
	await expect(sheet).toBeVisible();
	const back = page.getByTestId("picker-back");
	if (await back.isVisible()) await back.click();
}
