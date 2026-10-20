import { expect, type Page } from "@playwright/test";
import { dualDriverProviders } from "../../../test/e2e/fixtures/mockup-state.js";
import type { StepHandler } from "../runtime.js";
import {
	effortOptions,
	openComposerMoreSheet,
	refetchModelCatalog,
	rejectedEffortSwitches,
	requireRpcControl,
} from "./shared.js";

async function effortControl(page: Page) {
	if ((page.viewportSize()?.width ?? 0) < 768) {
		await openComposerMoreSheet(page);
		return page.getByTestId("composer-more-effort");
	}
	return page.getByTestId(/^(variant-badge|composer-word-effort)$/);
}

export const composerEffortHandlers: StepHandler[] = [
	{
		name: "set model effort options",
		match: /^the model offers effort levels (.+)$/,
		run: async ({ world, match }) => {
			const options = (match[1] ?? "").split(", ");
			effortOptions.set(world.page, options);
			requireRpcControl(world.page).setProjectSetting({
				_tag: "providerModels",
				providers: dualDriverProviders
					.filter((provider) => provider.id === "claude")
					.map((provider) => ({
						...provider,
						models: provider.models.map((model) => ({
							...model,
							variants: options,
						})),
					})),
			});
			await refetchModelCatalog(world.page);
			await expect(
				world.page
					.getByTestId(
						/^(variant-badge|composer-word-effort|model-picker-trigger|composer-words-sheet-trigger)$/,
					)
					.first(),
			).toBeVisible();
		},
	},
	{
		name: "tap effort word",
		match: /^I tap the effort word$/,
		run: async ({ world }) => {
			const button = world.page.getByTestId("composer-word-effort");
			await expect(button).not.toHaveAttribute("aria-busy", "true");
			await button.click();
		},
	},
	{
		name: "cycle effort with keyboard",
		match: /^I cycle effort with Ctrl\+T$/,
		run: async ({ world }) => {
			const button = world.page
				.getByTestId(
					/^(variant-badge|composer-word-effort|model-picker-trigger|composer-words-sheet-trigger)$/,
				)
				.first();
			await expect(button).not.toHaveAttribute("aria-busy", "true");
			await world.page.keyboard.press("Control+t");
		},
	},
	{
		name: "select effort level",
		match: /^I set effort to (\w+)$/,
		run: async ({ world, match }) => {
			const picker = world.page.getByTestId("model-picker");
			const alreadyOpen = await picker.isVisible();
			if (!alreadyOpen) await (await effortControl(world.page)).click();
			const option = picker.getByTestId(`picker-effort-option-${match[1]}`);
			await expect(option).toBeEnabled();
			await option.click();
			await expect(option).toHaveAttribute("aria-checked", "true");
			await expect(picker.getByTestId("picker-row-model")).toBeVisible();
			if (!alreadyOpen) {
				await world.page.keyboard.press("Escape");
				await expect(picker).toHaveCount(0);
			}
		},
	},
	{
		name: "assert effort word label",
		match: /^the effort word shows ([A-Za-z]+)$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId("composer-word-effort");
			await expect(button).toHaveText(match[1] ?? "");
			await expect(button).not.toHaveAttribute("aria-busy", "true");
		},
	},
	{
		name: "assert effort bars and fill",
		match: /^the effort meter has (\d+) bars with (\d+) filled$/,
		run: async ({ world, match }) => {
			const bars = (await effortControl(world.page)).locator(
				".effort-meter > span",
			);
			await expect(bars).toHaveCount(Number(match[1]));
			await expect
				.poll(() =>
					bars.evaluateAll(
						(elements) =>
							elements.filter(
								(element) =>
									getComputedStyle(element).backgroundColor ===
									getComputedStyle(element).color,
							).length,
					),
				)
				.toBe(Number(match[2]));
		},
	},
	{
		name: "assert picker offers every supplied effort level",
		match: /^the picker lists every offered effort level$/,
		run: async ({ world }) => {
			const options = effortOptions.get(world.page);
			if (!options) throw new Error("Effort options were not initialised");
			const picker = world.page.getByTestId("model-picker");
			await expect(picker).toBeVisible();
			const rows = picker.locator('[data-testid^="picker-effort-option-"]');
			await expect(rows).toHaveCount(options.length);
			const actual = await rows.evaluateAll((items) =>
				items.map((item) =>
					item
						.getAttribute("data-testid")
						?.replace("picker-effort-option-", ""),
				),
			);
			if (actual.join(", ") !== options.join(", ")) {
				throw new Error(`Unexpected picker effort order: ${actual.join(", ")}`);
			}
		},
	},
	{
		name: "assert effort menu closed",
		match: /^the effort menu is closed$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("variant-dropdown")).toHaveCount(0);
		},
	},
	{
		name: "reject next effort switch",
		match: /^the provider rejects the next effort switch$/,
		run: async ({ world }) => {
			rejectedEffortSwitches.add(world.page);
		},
	},
	{
		name: "assert rejected effort RPC and toast",
		match: /^the failed effort switch to (\w+) is reported$/,
		run: async ({ world, match }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SwitchVariant" &&
					request.payload["variant"] === match[1],
			);
			await expect(
				world.page
					.getByRole("status")
					.filter({ hasText: "Couldn't switch thinking level" }),
			).toContainText("Effort switch rejected by the provider");
		},
	},
];
