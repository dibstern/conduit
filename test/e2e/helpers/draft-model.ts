import type { Page } from "@playwright/test";
import type { ModelInfo } from "../../../src/lib/provider/types.js";
import { openPickerRoot } from "./model-picker.js";
import { expect } from "./process-harness-fixture.js";

// The fake SDK needs an explicit catalogue before a Draft can send.
export const claudeModels: readonly ModelInfo[] = [
	{
		id: "sonnet",
		name: "Sonnet",
		providerId: "claude",
		variants: { low: {}, high: {} },
		contextWindowOptions: [
			{ value: "200k", label: "200k", isDefault: true },
			{ value: "1m", label: "1M" },
		],
	},
];

export async function pickClaudeModel(page: Page) {
	const picker = page.locator(
		'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible, [data-testid="composer-words-sheet-trigger"]:visible',
	);
	await openPickerRoot(page, picker);
	if ((await picker.getAttribute("data-instance-id")) !== "claude")
		await page.getByTestId("picker-harness-claude").click();
	await page.getByTestId("picker-row-model").click();
	await page
		.getByTestId("model-picker-list")
		.locator('[data-model-id="sonnet"]')
		.click();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("model-picker")).toBeHidden();
}
