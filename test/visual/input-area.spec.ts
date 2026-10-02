// Playwright tests that navigate to Storybook story iframes and assert
// component behavior for the input area, attach menu, and context warning.

import { expect, test } from "@playwright/test";

const STORY_URL = (id: string) => `/iframe.html?id=${id}&viewMode=story`;

async function navigateToStory(
	page: import("@playwright/test").Page,
	storyId: string,
): Promise<void> {
	await page.goto(STORY_URL(storyId), { waitUntil: "domcontentloaded" });
	await expect(page.locator("#input")).toBeVisible();
}

test.describe("InputArea", () => {
	test("renders textarea with placeholder", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		const textarea = page.locator("#input");
		await expect(textarea).toBeVisible();
		// Phones get the short provider placeholder; wider viewports keep the hint.
		await expect(textarea).toHaveAttribute(
			"placeholder",
			/^Ask (anything\.|Claude…$)/,
		);
	});

	test("shows send button", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		const sendBtn = page.locator("#send");
		await expect(sendBtn).toBeVisible();
	});

	test("send button is disabled when textarea is empty", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		const sendBtn = page.locator("#send");
		await expect(sendBtn).toBeDisabled();
	});

	test("shows stop button during processing", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--processing");
		const stopBtn = page.locator("#stop");
		await expect(stopBtn).toBeVisible();
		await expect(stopBtn).toHaveAttribute("title", "Stop generating");
	});

	test("shows model selector", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		const modelDisplay = page.locator("#model-display");
		await expect(modelDisplay).toBeVisible();
		// Agent selector is only shown when 2+ agents are configured
		const agentSelector = page.locator("#agent-selector-wrap");
		await expect(agentSelector).toBeAttached();
	});
});

test.describe("AttachMenu", () => {
	test("attach button is visible", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		const attachBtn = page.locator("#attach-btn");
		await expect(attachBtn).toBeVisible();
	});

	test("opens attach menu on click", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		const attachBtn = page.locator("#attach-btn");
		const attachMenu = page.locator("[data-testid='attach-menu']");

		// Menu starts hidden
		await expect(attachMenu).toBeHidden();

		// Click opens it
		await attachBtn.click();
		await expect(attachMenu).toBeVisible();
	});

	test("shows camera and photos options", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		await page.locator("#attach-btn").click();

		const cameraOption = page.locator("#attach-camera");
		const photosOption = page.locator("#attach-photos");
		await expect(cameraOption).toBeVisible();
		await expect(cameraOption).toContainText("Take Photo");
		await expect(photosOption).toBeVisible();
		await expect(photosOption).toContainText("Add Photos");
	});

	test("closes attach menu on outside click", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		const attachBtn = page.locator("#attach-btn");
		const attachMenu = page.locator("[data-testid='attach-menu']");

		// Open the menu
		await attachBtn.click();
		await expect(attachMenu).toBeVisible();

		// Click outside (on the textarea area)
		await page.locator("#input").click();
		await expect(attachMenu).toBeHidden();
	});
});

test.describe("Context warning", () => {
	test("not visible when context is 0%", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		await expect(page.getByTestId("composer-context-warning")).toHaveCount(0);
	});

	test("no warning below the default threshold", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--with-context-bar");
		await expect(page.getByTestId("composer-context-warning")).toHaveCount(0);
		const usage = page.getByTestId("composer-word-context-usage");
		await expect(usage).toHaveText("42%");
		await expect(usage).not.toHaveAttribute("data-warning", "true");
	});

	for (const [story, percent] of [
		["high-context", 85],
		["critical-context", 97],
	] as const) {
		test(`warns at ${percent}%`, async ({ page }) => {
			await navigateToStory(page, `input-inputarea--${story}`);
			const warning = page.getByTestId("composer-context-warning");
			await expect(warning).toBeVisible();
			await expect(warning).toHaveText(
				`Context ${percent}% full. Older turns compact soon.`,
			);
			const usage = page.getByTestId("composer-word-context-usage");
			await expect(usage).toHaveText(`${percent}%`);
			await expect(usage).toHaveAttribute("data-warning", "true");
		});
	}
});
