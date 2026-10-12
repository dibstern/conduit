import { expect, test } from "@playwright/test";

const STORY_URL = "/iframe.html?id=fixtures-modalfocus--default&viewMode=story";

test.describe("Modal focus", () => {
	test("keeps keyboard focus off the background and restores it on close", async ({
		page,
	}) => {
		await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
		const outside = page.locator("#outside-btn");
		const trigger = page.locator("#trigger");
		const first = page.locator("#first");
		const last = page.locator("#last");

		await trigger.click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(first).toBeFocused();
		// showModal() blocks the rest of the page implicitly; no inert attribute is set.
		expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(
			true,
		);

		// A native modal dialog lets Tab leave for the browser chrome rather than
		// wrapping, but it must never reach the page behind the dialog.
		await last.focus();
		await page.keyboard.press("Tab");
		await expect(outside).not.toBeFocused();
		await expect(trigger).not.toBeFocused();
		await first.focus();
		await page.keyboard.press("Shift+Tab");
		await expect(outside).not.toBeFocused();
		await expect(trigger).not.toBeFocused();

		// Independent check: focusing the background button directly is a
		// no-op while the native modal dialog is open.
		await page.evaluate(() => document.getElementById("outside-btn")?.focus());
		await expect(outside).not.toBeFocused();

		// Focus returns to the opener after a keyboard close; a pointer close drops it.
		await last.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("dialog")).toBeHidden();
		await expect(trigger).toBeFocused();
	});
});
