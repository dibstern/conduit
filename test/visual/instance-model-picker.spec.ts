// Tests picker navigation, dismissal, and coordination with the variant menu.

import { expect, type Locator, type Page, test } from "@playwright/test";

function storyUrl(storyId: string): string {
	// Relative, so Playwright resolves it against the config's baseURL. A
	// hardcoded host pinned these specs to port 6007 no matter which port the
	// run actually started — so a second worktree's run silently exercised the
	// FIRST worktree's build, which is the exact failure `reuseExistingServer:
	// false` was added to prevent. See conduit-test-afp.
	return `/iframe.html?id=${storyId}&viewMode=story`;
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

/**
 * Phones keep the effort menu; the desktop effort control opens the model
 * picker on its effort row (conduit-test-bn6x.8). Returns whichever opened.
 */
async function openEffortMenu(page: Page): Promise<Locator> {
	const badge = page.getByTestId("variant-badge");
	if (isPhone(page)) {
		await badge.press("Shift+F10");
		return page.getByTestId("variant-dropdown");
	}
	await badge.click();
	await expect(page.getByTestId("picker-row-effort")).toBeVisible();
	return page.getByTestId("model-picker");
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
		// A lone harness offers no choice, so the root skips that section.
		await expect(page.getByTestId("picker-harness-section")).toHaveCount(0);
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
		// Phones show only a short tag (O4.1), so assert the accessible name.
		await expect(page.getByTestId("model-picker-trigger")).toHaveAttribute(
			"aria-label",
			/Claude Opus 4\.1/,
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
		await page.getByTestId("picker-harness-opencode").click();

		await expect(page.getByTestId("model-picker")).toBeVisible();
		await expect(page.getByTestId("picker-harness-opencode")).toHaveAttribute(
			"aria-checked",
			"true",
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
		const other = page.getByTestId("picker-harness-opencode");
		await expect(other).toHaveAttribute("aria-disabled", "true");
		await expect(page.getByTestId("picker-harness-caption")).toContainText(
			/fixed for this session/i,
		);
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

	test("opens the effort menu from the badge", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("variant-badge")).toBeVisible();
		await expect(page.getByTestId("variant-dropdown")).toBeHidden();
		await expect(page.getByTestId("model-picker")).toBeHidden();

		await expect(await openEffortMenu(page)).toBeVisible();
	});

	test("closes the effort menu on Escape", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("variant-badge")).toBeVisible();

		const menu = await openEffortMenu(page);
		await expect(menu).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
	});

	test("marks the current variant", async ({ page }) => {
		await page.goto(storyUrl("model-instancemodelpicker--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("variant-badge")).toBeVisible();

		await expect(await openEffortMenu(page)).toBeVisible();

		// The current variant is "high".
		if (!isPhone(page)) {
			await expect(
				page.getByTestId("picker-effort-option-high"),
			).toHaveAttribute("data-state", "checked");
			await expect(
				page.getByTestId("picker-effort-option-low"),
			).not.toHaveAttribute("data-state", "checked");
			return;
		}
		// Since conduit-test-de3.35.4 the check is ui/MenuRadioItem's
		// `data-menu-radio-check` icon, not a literal ✓ glyph.
		const highOption = page.getByTestId("variant-option-high");
		await expect(highOption).toBeVisible();
		await expect(highOption.locator("[data-menu-radio-check]")).toBeVisible();
		const lowOption = page.getByTestId("variant-option-low");
		await expect(lowOption).toBeVisible();
		await expect(lowOption.locator("[data-menu-radio-check]")).toHaveCount(0);
	});
});

test.describe("InstanceModelPicker + ModelVariant coordination", () => {
	test("opening model dropdown closes variant dropdown", async ({ page }) => {
		test.skip(
			!isPhone(page),
			"Desktop effort opens the model picker itself; there is no second menu",
		);
		await page.goto(storyUrl("model-instancemodelpicker--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("variant-badge")).toBeVisible();

		await expect(await openEffortMenu(page)).toBeVisible();

		await page.getByTestId("model-picker-trigger").click();
		await expect(page.getByTestId("model-picker")).toBeVisible();
		await expect(page.getByTestId("variant-dropdown")).toBeHidden();
	});

	test("effort menu respects desktop dismissal and phone sheet modality", async ({
		page,
	}) => {
		await page.goto(storyUrl("model-instancemodelpicker--with-variants"), {
			waitUntil: "domcontentloaded",
		});
		await expect(page.getByTestId("variant-badge")).toBeVisible();

		// Open the model dropdown first
		await page.getByTestId("model-picker-trigger").click();
		await expect(page.getByTestId("model-picker")).toBeVisible();

		if (!isPhone(page)) {
			// The open picker moves to its effort row rather than closing.
			await page.getByTestId("variant-badge").click();
			await expect(page.getByTestId("picker-row-effort")).toBeVisible();
			await page.mouse.click(5, 5);
			await expect(page.getByTestId("model-picker")).toBeHidden();
			return;
		}

		await expect(page.locator("dialog:modal")).toBeVisible();
		const badge = page.getByTestId("variant-badge");
		await badge.focus();
		await expect(badge).not.toBeFocused();
		await expect(page.getByTestId("variant-dropdown")).toBeHidden();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("model-picker")).toBeHidden();

		await expect(await openEffortMenu(page)).toBeVisible();
		await expect(page.getByTestId("model-picker")).toBeHidden();
	});
});
