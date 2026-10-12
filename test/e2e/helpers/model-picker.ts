import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Opens the model picker at its root, where the harness, account, model and
 * effort rows live. The phone chip and the words composer's model word open
 * straight into the model list instead.
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
