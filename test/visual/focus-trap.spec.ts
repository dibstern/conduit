import { expect, test } from "@playwright/test";

const STORY_URL = "/iframe.html?id=actions-focustrap--default&viewMode=story";

test.describe("focusTrap", () => {
	test("contains native Tab focus, inerts the background, and restores focus", async ({
		page,
	}) => {
		await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
		const outside = page.locator("#outside-btn");
		const trigger = page.locator("#trigger");

		await trigger.click();

		expect(await page.evaluate(() => document.activeElement?.id)).toBe("first");
		await expect(page.locator("#trap")).toBeVisible();
		await expect(outside).toHaveAttribute("inert", "");
		expect(
			await outside.evaluate((element: HTMLElement) => element.inert),
		).toBe(true);

		await page.locator("#last").focus();
		await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.id)).toBe("first");

		// Independent inert check: focusing the background button directly is a
		// no-op under native inert (not merely masked by the trap's focusin guard).
		await page.evaluate(() => document.getElementById("outside-btn")?.focus());
		expect(await page.evaluate(() => document.activeElement?.id)).not.toBe(
			"outside-btn",
		);

		await page.locator("#last").click();
		await expect(page.locator("#trap")).toBeHidden();
		expect(await page.evaluate(() => document.activeElement?.id)).toBe(
			"trigger",
		);
	});
});
