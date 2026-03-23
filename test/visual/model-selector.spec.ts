// ─── ModelSelector + ModelVariant Interaction Tests ──────────────────────────
// Tests dropdown open/close, keyboard handling, and mutual exclusion between
// the model dropdown and the variant dropdown.

import { expect, test } from "@playwright/test";

const STORYBOOK = "http://localhost:6007";

function storyUrl(storyId: string): string {
	return `${STORYBOOK}/iframe.html?id=${storyId}&viewMode=story`;
}

// ─── ModelSelector ───────────────────────────────────────────────────────────

test.describe("ModelSelector", () => {
	test("displays current model name", async ({ page }) => {
		await page.goto(storyUrl("model-modelselector--closed"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".model-btn");
		await page.waitForTimeout(200);

		const label = page.locator(".model-btn .model-label");
		await expect(label).toBeVisible();
		await expect(label).toHaveText(/Claude Sonnet 4/);
	});

	test("opens dropdown on click", async ({ page }) => {
		await page.goto(storyUrl("model-modelselector--closed"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".model-btn");
		await page.waitForTimeout(200);

		// Dropdown should not be visible initially
		await expect(page.locator(".model-dropdown")).toBeHidden();

		// Click the model button to open
		await page.locator(".model-btn").click();
		await expect(page.locator(".model-dropdown")).toBeVisible();
	});

	test("shows provider groups with models", async ({ page }) => {
		// The "Open" story already has the dropdown open via its play function
		await page.goto(storyUrl("model-modelselector--open"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".model-dropdown");
		await page.waitForTimeout(200);

		// Should show provider header
		const providerHeader = page.locator(".model-provider-header");
		await expect(providerHeader.first()).toBeVisible();
		await expect(providerHeader.first()).toHaveText(/Anthropic/);

		// Should show model items
		const modelItems = page.locator(".model-item");
		expect(await modelItems.count()).toBeGreaterThanOrEqual(2);

		// Active model should have a checkmark
		const activeItem = page.locator(".model-item-active");
		await expect(activeItem).toBeVisible();
		await expect(activeItem.locator(".model-check")).toBeVisible();
	});

	test("closes dropdown on Escape", async ({ page }) => {
		await page.goto(storyUrl("model-modelselector--open"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".model-dropdown");
		await page.waitForTimeout(200);

		// Dropdown should be open (play function opens it)
		await expect(page.locator(".model-dropdown")).toBeVisible();

		// Press Escape
		await page.keyboard.press("Escape");
		await expect(page.locator(".model-dropdown")).toBeHidden();
	});

	test("closes dropdown on outside click", async ({ page }) => {
		await page.goto(storyUrl("model-modelselector--open"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector(".model-dropdown");
		await page.waitForTimeout(200);

		await expect(page.locator(".model-dropdown")).toBeVisible();

		// Click outside the component
		await page.locator("body").click({ position: { x: 10, y: 10 } });
		await expect(page.locator(".model-dropdown")).toBeHidden();
	});
});

// ─── ModelVariant ────────────────────────────────────────────────────────────

test.describe("ModelVariant", () => {
	test("shows variant badge when model has variants", async ({ page }) => {
		await page.goto(storyUrl("model-modelselector--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector('[data-testid="variant-badge"]');
		await page.waitForTimeout(200);

		const badge = page.locator('[data-testid="variant-badge"]');
		await expect(badge).toBeVisible();
		// The WithVariants story sets currentVariant to "high"
		await expect(badge).toHaveText(/high/);
	});

	test("opens variant dropdown on badge click", async ({ page }) => {
		await page.goto(storyUrl("model-modelselector--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector('[data-testid="variant-badge"]');
		await page.waitForTimeout(200);

		// Dropdown should not be visible initially
		await expect(page.locator('[data-testid="variant-dropdown"]')).toBeHidden();

		// Click the variant badge
		await page.locator('[data-testid="variant-badge"]').click();
		await expect(
			page.locator('[data-testid="variant-dropdown"]'),
		).toBeVisible();
	});

	test("closes variant dropdown on Escape", async ({ page }) => {
		await page.goto(storyUrl("model-modelselector--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector('[data-testid="variant-badge"]');
		await page.waitForTimeout(200);

		// Open the variant dropdown
		await page.locator('[data-testid="variant-badge"]').click();
		await expect(
			page.locator('[data-testid="variant-dropdown"]'),
		).toBeVisible();

		// Press Escape
		await page.keyboard.press("Escape");
		await expect(page.locator('[data-testid="variant-dropdown"]')).toBeHidden();
	});

	test("shows checkmark on current variant", async ({ page }) => {
		await page.goto(storyUrl("model-modelselector--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector('[data-testid="variant-badge"]');
		await page.waitForTimeout(200);

		// Open the variant dropdown
		await page.locator('[data-testid="variant-badge"]').click();
		await expect(
			page.locator('[data-testid="variant-dropdown"]'),
		).toBeVisible();

		// The current variant is "high" — its option should have a checkmark (✓)
		const highOption = page.locator('[data-testid="variant-option-high"]');
		await expect(highOption).toBeVisible();
		await expect(highOption).toHaveText(/✓/);

		// Other options should NOT have a checkmark
		const lowOption = page.locator('[data-testid="variant-option-low"]');
		await expect(lowOption).toBeVisible();
		await expect(lowOption).not.toHaveText(/✓/);
	});
});

// ─── ModelSelector + ModelVariant coordination ──────────────────────────────

test.describe("ModelSelector + ModelVariant coordination", () => {
	test("opening model dropdown closes variant dropdown", async ({ page }) => {
		await page.goto(storyUrl("model-modelselector--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector('[data-testid="variant-badge"]');
		await page.waitForTimeout(200);

		// Open the variant dropdown first
		await page.locator('[data-testid="variant-badge"]').click();
		await expect(
			page.locator('[data-testid="variant-dropdown"]'),
		).toBeVisible();

		// Now click the model button to open model dropdown
		await page.locator(".model-btn").click();
		await expect(page.locator(".model-dropdown")).toBeVisible();

		// Variant dropdown should be closed
		await expect(page.locator('[data-testid="variant-dropdown"]')).toBeHidden();
	});

	test("opening variant dropdown closes model dropdown", async ({ page }) => {
		await page.goto(storyUrl("model-modelselector--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await page.waitForSelector('[data-testid="variant-badge"]');
		await page.waitForTimeout(200);

		// Open the model dropdown first
		await page.locator(".model-btn").click();
		await expect(page.locator(".model-dropdown")).toBeVisible();

		// Now click the variant badge to open variant dropdown
		await page.locator('[data-testid="variant-badge"]').click();
		await expect(
			page.locator('[data-testid="variant-dropdown"]'),
		).toBeVisible();

		// Model dropdown should be closed
		await expect(page.locator(".model-dropdown")).toBeHidden();
	});
});
