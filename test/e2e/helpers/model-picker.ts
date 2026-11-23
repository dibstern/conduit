import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Opens the model picker at its root, where the harness, account, model and
 * effort rows live. Both phone and desktop triggers open it directly.
 */
export async function openPickerRoot(
	page: Page,
	trigger: Locator,
): Promise<void> {
	const panel = page.getByTestId("model-picker");
	if (!(await panel.isVisible())) await trigger.click();
	await expect(panel).toBeVisible();
	const back = page.getByTestId("picker-back");
	if (await back.isVisible()) await back.click();
}

/** Opens the Account drill-in from an already open picker. */
export async function openPickerAccounts(page: Page): Promise<void> {
	const options = page.getByTestId("picker-account-options");
	if (!(await options.isVisible()))
		await page.getByTestId("picker-row-account").click();
	await expect(options).toBeVisible();
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

/** Opens checkout details through the chip's focused Session panel row. */
export async function openCheckoutDetails(page: Page): Promise<Locator> {
	await openPickerRoot(
		page,
		page.locator(
			'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
		),
	);
	await page.getByTestId("picker-row-checkout").click();
	const details = page.getByTestId("checkout-details");
	await expect(details).toBeVisible();
	return details;
}
