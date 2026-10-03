// Tests picker navigation, dismissal, and coordination with the variant menu.

import { expect, type Page, test } from "@playwright/test";

function storyUrl(storyId: string): string {
	// Relative, so Playwright resolves it against the config's baseURL. A
	// hardcoded host pinned these specs to port 6007 no matter which port the
	// run actually started — so a second worktree's run silently exercised the
	// FIRST worktree's build, which is the exact failure `reuseExistingServer:
	// false` was added to prevent. See conduit-test-afp.
	return `/iframe.html?id=${storyId}&viewMode=story`;
}

async function openVariantMenu(page: Page): Promise<void> {
	const badge = page.getByTestId("variant-badge");
	if ((page.viewportSize()?.width ?? 1440) < 768) {
		await badge.press("Shift+F10");
	} else {
		await badge.click();
	}
}

test.describe("InstanceModelPicker", () => {
	test("displays current model name", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--closed"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("model-picker-trigger")).toBeVisible();

		// Phones show only a short tag (S4), so assert the accessible name.
		await expect(page.getByTestId("model-picker-trigger")).toHaveAttribute(
			"aria-label",
			/Sonnet 4/,
		);
	});

	test("opens the harness and model root on click", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--closed"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("model-picker-trigger")).toBeVisible();

		await expect(page.getByTestId("model-picker")).toBeHidden();

		await page.getByTestId("model-picker-trigger").click();
		await expect(page.getByTestId("model-picker")).toBeVisible();
		await expect(page.getByTestId("model-picker")).toContainText(
			"Harness & model",
		);
		await expect(page.getByTestId("picker-row-harness")).toBeVisible();
		await expect(page.getByTestId("picker-row-model")).toBeVisible();
		await expect(page.getByTestId("model-picker-search")).toHaveCount(0);
	});

	test("shows provider groups with models", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--open"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("picker-row-model")).toBeVisible();
		await page.getByTestId("picker-row-model").click();
		// Phones focus Back instead, so the keyboard does not cover the list.
		const phone = (page.viewportSize()?.width ?? 1440) < 768;
		await expect(
			page.getByTestId(phone ? "picker-back" : "model-picker-search"),
		).toBeFocused();

		const providerHeader = page.locator(".model-provider-header");
		await expect(providerHeader.first()).toBeVisible();
		// Rendered uppercase via CSS, so match case-insensitively.
		await expect(providerHeader.first()).toHaveText(/anthropic/i);

		const modelItems = page.locator(".model-item");
		await expect(modelItems).toHaveCount(2);

		const activeItem = page.locator(".model-item-active");
		await expect(activeItem).toBeVisible();
		await expect(activeItem.locator(".model-check")).toBeVisible();
	});

	test("Back returns from models to the open root", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--open"), {
			waitUntil: "domcontentloaded",
		});
		await page.getByTestId("picker-row-model").click();
		await expect(page.getByTestId("model-picker-search")).toBeVisible();

		await page.getByRole("button", { name: "Back", exact: true }).click();

		await expect(page.getByTestId("model-picker")).toBeVisible();
		await expect(page.getByTestId("picker-row-model")).toBeVisible();
		await expect(page.getByTestId("picker-back")).toHaveCount(0);
	});

	test("selecting a model returns to the root and keeps it open", async ({
		page,
	}) => {
		await page.goto(storyUrl("model-instancemodelpicker--open"), {
			waitUntil: "domcontentloaded",
		});
		await page.getByTestId("picker-row-model").click();
		await page.locator('.model-item[data-model-id="claude-opus-4-1"]').click();

		await expect(page.getByTestId("model-picker")).toBeVisible();
		await expect(page.getByTestId("picker-row-model")).toContainText(
			"Claude Opus 4.1",
		);
		await expect(page.getByTestId("picker-back")).toHaveCount(0);
		await expect(page.getByTestId("model-picker-trigger")).toContainText(
			"Claude Opus 4.1",
		);

		await page.getByTestId("picker-row-model").click();
		await expect(page.locator(".model-item-active")).toHaveAttribute(
			"data-model-id",
			"claude-opus-4-1",
		);
	});

	test("selecting a harness returns to the root and keeps it open", async ({
		page,
	}) => {
		await page.goto(storyUrl("model-instancemodelpicker--unlocked-harnesses"), {
			waitUntil: "domcontentloaded",
		});
		await page.getByTestId("picker-instance-opencode").click();

		await expect(page.getByTestId("model-picker")).toBeVisible();
		await expect(page.getByTestId("picker-row-harness")).toContainText(
			"OpenCode",
		);
		await expect(page.getByTestId("picker-row-model")).toBeVisible();
		await expect(page.getByTestId("picker-back")).toHaveCount(0);

		await page.getByTestId("picker-row-model").click();
		await expect(page.locator(".model-provider-header")).toHaveText(
			/opencode/i,
		);
		await expect(
			page.locator('.model-item[data-provider-id="opencode"]'),
		).toHaveCount(1);
	});

	test("shows locked harnesses with the session lock reason", async ({
		page,
	}) => {
		await page.goto(storyUrl("model-instancemodelpicker--locked"), {
			waitUntil: "domcontentloaded",
		});
		const other = page.getByTestId("picker-instance-opencode");
		await expect(other).toHaveAttribute("aria-disabled", "true");
		await expect(other).toContainText(/fixed for this session/i);
	});

	test("closes picker on Escape", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--open"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("model-picker")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByTestId("model-picker")).toBeHidden();
	});

	test("closes picker on outside click", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--open"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("model-picker")).toBeVisible();

		// The upper-left corner is outside the desktop popover and phone sheet.
		await page.mouse.click(10, 150);
		await expect(page.getByTestId("model-picker")).toBeHidden();
	});
});

test.describe("ModelVariant", () => {
	test("shows variant badge when model has variants", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.locator('[data-testid="variant-badge"]')).toBeVisible();

		const badge = page.locator('[data-testid="variant-badge"]');
		await expect(badge).toBeVisible();
		// The WithVariants story sets currentVariant to "high"
		await expect(badge).toHaveText(/high/i);
	});

	test("opens variant dropdown from the badge", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.locator('[data-testid="variant-badge"]')).toBeVisible();

		// Dropdown should not be visible initially
		await expect(page.locator('[data-testid="variant-dropdown"]')).toBeHidden();

		await openVariantMenu(page);
		await expect(
			page.locator('[data-testid="variant-dropdown"]'),
		).toBeVisible();
	});

	test("closes variant dropdown on Escape", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.locator('[data-testid="variant-badge"]')).toBeVisible();

		await openVariantMenu(page);
		await expect(
			page.locator('[data-testid="variant-dropdown"]'),
		).toBeVisible();

		// Press Escape
		await page.keyboard.press("Escape");
		await expect(page.locator('[data-testid="variant-dropdown"]')).toBeHidden();
	});

	test("shows checkmark on current variant", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.locator('[data-testid="variant-badge"]')).toBeVisible();

		await openVariantMenu(page);
		await expect(
			page.locator('[data-testid="variant-dropdown"]'),
		).toBeVisible();

		// The current variant is "high". Since conduit-test-de3.35.4 the check is
		// ui/MenuRadioItem's `data-menu-radio-check` icon, not a literal ✓ glyph.
		const highOption = page.locator('[data-testid="variant-option-high"]');
		await expect(highOption).toBeVisible();
		await expect(highOption.locator("[data-menu-radio-check]")).toBeVisible();

		// Other options should NOT have a checkmark
		const lowOption = page.locator('[data-testid="variant-option-low"]');
		await expect(lowOption).toBeVisible();
		await expect(lowOption.locator("[data-menu-radio-check]")).toHaveCount(0);
	});
});

test.describe("InstanceModelPicker + ModelVariant coordination", () => {
	test("opening model dropdown closes variant dropdown", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.locator('[data-testid="variant-badge"]')).toBeVisible();

		await openVariantMenu(page);
		await expect(
			page.locator('[data-testid="variant-dropdown"]'),
		).toBeVisible();

		// Now click the model button to open model dropdown
		await page.getByTestId("model-picker-trigger").click();
		await expect(page.getByTestId("model-picker")).toBeVisible();

		// Variant dropdown should be closed
		await expect(page.locator('[data-testid="variant-dropdown"]')).toBeHidden();
	});

	test("effort menu respects desktop dismissal and phone sheet modality", async ({
		page,
	}) => {
		await page.goto(storyUrl("model-instancemodelpicker--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.locator('[data-testid="variant-badge"]')).toBeVisible();

		// Open the model dropdown first
		await page.getByTestId("model-picker-trigger").click();
		await expect(page.getByTestId("model-picker")).toBeVisible();

		if ((page.viewportSize()?.width ?? 1440) < 768) {
			await expect(page.locator("dialog:modal")).toBeVisible();
			const badge = page.getByTestId("variant-badge");
			await badge.focus();
			await expect(badge).not.toBeFocused();
			await expect(page.getByTestId("variant-dropdown")).toBeHidden();
			await page.keyboard.press("Escape");
			await expect(page.getByTestId("model-picker")).toBeHidden();
		}

		await openVariantMenu(page);
		await expect(
			page.locator('[data-testid="variant-dropdown"]'),
		).toBeVisible();

		// Model dropdown should be closed
		await expect(page.getByTestId("model-picker")).toBeHidden();
	});
});
