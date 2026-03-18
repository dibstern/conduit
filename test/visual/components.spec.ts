import { expect, test } from "@playwright/test";

// Phase 0: Proof-of-concept — App component
test.describe("App", () => {
	test("default", async ({ page }) => {
		await page.goto("/iframe.html?id=app--default&viewMode=story");
		await page
			.waitForSelector("[data-v-app]", { state: "attached", timeout: 5000 })
			.catch(() => {
				// Fallback: just wait for the root to render
			});
		await page.waitForTimeout(500);
		await expect(page.locator("#storybook-root")).toHaveScreenshot();
	});
});

// Phases 2-6 will add component tests below this line.
