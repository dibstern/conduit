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
		await expect(outside).toHaveAttribute("inert", "");
		expect(
			await outside.evaluate((element: HTMLElement) => element.inert),
		).toBe(true);

		await last.focus();
		await page.keyboard.press("Tab");
		await expect(first).toBeFocused();

		// Independent inert check: focusing the background button directly is a
		// no-op under native inert (not merely masked by Bits' focus guard).
		await page.evaluate(() => document.getElementById("outside-btn")?.focus());
		await expect(outside).not.toBeFocused();

		await last.click();
		await expect(page.getByRole("dialog")).toBeHidden();
		await expect(trigger).toBeFocused();
	});
});
