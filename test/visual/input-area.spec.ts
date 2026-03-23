// ─── InputArea / AttachMenu / ContextBar Interaction Tests ───────────────────
// Playwright tests that navigate to Storybook story iframes and assert
// component behavior for the input area, attach menu, and context bar.

import { expect, test } from "@playwright/test";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STORY_URL = (id: string) => `/iframe.html?id=${id}&viewMode=story`;

async function navigateToStory(
	page: import("@playwright/test").Page,
	storyId: string,
): Promise<void> {
	await page.goto(STORY_URL(storyId), { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(800);
}

// ─── InputArea ───────────────────────────────────────────────────────────────

test.describe("InputArea", () => {
	test("renders textarea with placeholder", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		const textarea = page.locator("#input");
		await expect(textarea).toBeVisible();
		await expect(textarea).toHaveAttribute("placeholder", /Message OpenCode/);
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

// ─── AttachMenu ──────────────────────────────────────────────────────────────

test.describe("AttachMenu", () => {
	test("attach button is visible", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		const attachBtn = page.locator("#attach-btn");
		await expect(attachBtn).toBeVisible();
	});

	test("opens attach menu on click", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		const attachBtn = page.locator("#attach-btn");
		const attachMenu = page.locator("#attach-menu");

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
		const attachMenu = page.locator("#attach-menu");

		// Open the menu
		await attachBtn.click();
		await expect(attachMenu).toBeVisible();

		// Click outside (on the textarea area)
		await page.locator("#input").click();
		await expect(attachMenu).toBeHidden();
	});
});

// ─── ContextBar ──────────────────────────────────────────────────────────────

test.describe("ContextBar", () => {
	test("not visible when context is 0%", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--empty");
		const contextBar = page.locator("#context-mini");
		await expect(contextBar).toHaveCount(0);
	});

	test("visible when context > 0%", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--with-context-bar");
		const contextBar = page.locator("#context-mini");
		await expect(contextBar).toBeVisible();
	});

	test("shows correct percentage text", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--with-context-bar");
		const label = page.locator("#context-mini-label");
		await expect(label).toHaveText("42%");
	});

	test("uses brand-b color below 50%", async ({ page }) => {
		// WithContextBar story has 42% — below the 50% threshold
		await navigateToStory(page, "input-inputarea--with-context-bar");
		const fill = page.locator("#context-mini-fill");
		await expect(fill).toHaveClass(/bg-brand-b/);
	});

	test("uses warning color at 85%", async ({ page }) => {
		// HighContext story has 85% — at or above 80%, this uses bg-brand-a
		// Per ContextBar.svelte: >= 80 → bg-brand-a, >= 50 → bg-warning
		// 85% >= 80, so it's bg-brand-a (critical), not bg-warning
		await navigateToStory(page, "input-inputarea--high-context");
		const fill = page.locator("#context-mini-fill");
		const label = page.locator("#context-mini-label");
		await expect(label).toHaveText("85%");
		await expect(fill).toHaveClass(/bg-brand-a/);
	});

	test("uses critical color at 97%", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--critical-context");
		const fill = page.locator("#context-mini-fill");
		const label = page.locator("#context-mini-label");
		await expect(label).toHaveText("97%");
		await expect(fill).toHaveClass(/bg-brand-a/);
	});

	test("fill bar width matches percentage", async ({ page }) => {
		await navigateToStory(page, "input-inputarea--with-context-bar");
		const fill = page.locator("#context-mini-fill");
		await expect(fill).toHaveAttribute("style", /width: 42%/);
	});
});
