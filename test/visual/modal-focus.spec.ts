import { expect, test } from "@playwright/test";

const STORY_URL = "/iframe.html?id=fixtures-modalfocus--default&viewMode=story";

test.describe("Modal focus", () => {
	test("contains native Tab focus, inerts the background, and restores focus", async ({
		page,
	}) => {
		await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
		const outside = page.locator("#outside-btn");
		const trigger = page.locator("#trigger");
		const first = page.locator("#first");
		const last = page.locator("#last");

		await trigger.click();

		await expect(page.getByRole("dialog")).toBeVisible();
		await expect(first).toBeFocused();

		// Native showModal() does not wrap Tab inside the dialog: past the last
		// control focus leaves for the browser UI. What it guarantees is that Tab
		// never lands on the inert page behind.
		await last.focus();
		await page.keyboard.press("Tab");
		await expect(outside).not.toBeFocused();
		await expect(trigger).not.toBeFocused();

		// The background is inert without an `inert` attribute, so test the
		// behaviour: focusing the background button directly must be a no-op.
		await page.evaluate(() => document.getElementById("outside-btn")?.focus());
		await expect(outside).not.toBeFocused();

		// A keyboard close hands focus back to the opener. A pointer close drops
		// it on purpose (WebKit would ring the opener), so close with Enter.
		await last.press("Enter");
		await expect(page.getByRole("dialog")).toBeHidden();
		await expect(trigger).toBeFocused();
	});
});
