import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import {
	effortOptions,
	rejectedEffortSwitches,
	requireRelayControl,
	requireRpcControl,
} from "./shared.js";

export const composerEffortHandlers: StepHandler[] = [
	{
		name: "set model effort options",
		match: /^the model offers effort levels (.+)$/,
		run: async ({ world, match }) => {
			const options = (match[1] ?? "").split(", ");
			effortOptions.set(world.page, options);
			await requireRelayControl(world.page).sendMessages([
				{ type: "variant_info", variant: "", variants: options },
			]);
			await expect(
				world.page.getByTestId(/^(variant-badge|composer-word-effort)$/),
			).toBeVisible();
		},
	},
	{
		name: "tap effort meter",
		match: /^I tap the effort (meter|word)$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId(
				match[1] === "word" ? "composer-word-effort" : "variant-badge",
			);
			await expect(button).not.toHaveAttribute("aria-busy", "true");
			await button.click();
		},
	},
	{
		name: "cycle effort with keyboard",
		match: /^I cycle effort with Ctrl\+T$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("variant-badge")).not.toHaveAttribute(
				"aria-busy",
				"true",
			);
			await world.page.keyboard.press("Control+t");
		},
	},
	{
		name: "hold effort meter",
		match: /^I hold the effort (meter|word)$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId(
				match[1] === "word" ? "composer-word-effort" : "variant-badge",
			);
			await expect(button).not.toHaveAttribute("aria-busy", "true");
			await button.click({ delay: 500 });
			await expect(world.page.getByTestId("variant-dropdown")).toBeVisible();
		},
	},
	{
		name: "select effort level",
		match: /^I set effort to (\w+)$/,
		run: async ({ world, match }) => {
			const picker = world.page.getByTestId("model-picker");
			if (await picker.isVisible()) {
				if (match[1] !== "default") {
					const option = picker.getByTestId(`picker-effort-option-${match[1]}`);
					await expect(option).toBeEnabled();
					await option.click();
					await expect(option).toHaveAttribute("aria-checked", "true");
					await expect(picker.getByTestId("picker-row-model")).toBeVisible();
					return;
				}
				await world.page.keyboard.press("Escape");
				await expect(picker).toHaveCount(0);
			}
			const menu = world.page.getByTestId("variant-dropdown");
			if (!(await menu.isVisible())) {
				const button = world.page.getByTestId(
					/^(variant-badge|composer-word-effort)$/,
				);
				await expect(button).not.toHaveAttribute("aria-busy", "true");
				if (
					(world.page.viewportSize()?.width ?? 1440) < 768 ||
					(await button.getAttribute("data-testid")) === "composer-word-effort"
				) {
					// Hold, as a phone user would. Shift+F10 leaves a keyboard focus
					// ring on the chip, which then lands in the visual baselines.
					await button.click({ delay: 500 });
				} else {
					await button.click();
				}
				await expect(menu).toBeVisible();
			}
			await world.page.getByTestId(`variant-option-${match[1]}`).click();
			const trigger = world.page.getByTestId(
				/^(variant-badge|composer-word-effort)$/,
			);
			await expect(trigger).not.toHaveAttribute("aria-busy", "true");
			// Closing hands focus back to the trigger, which lights the composer
			// ring; baselines taken mid-close caught it either way.
			await expect(menu).toBeHidden();
		},
	},
	{
		name: "assert effort micro label",
		match: /^the effort (meter|word) shows ([A-Za-z]+)$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId(
				match[1] === "word" ? "composer-word-effort" : "variant-badge",
			);
			await expect(button).toHaveText(match[2] ?? "");
			await expect(button).not.toHaveAttribute("aria-busy", "true");
		},
	},
	{
		name: "assert effort bars and fill",
		match: /^the effort meter has (\d+) bars with (\d+) filled$/,
		run: async ({ world, match }) => {
			const bars = world.page
				.getByTestId("variant-badge")
				.locator(".effort-meter > span");
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
		name: "assert effort menu offers default and every level",
		match: /^the effort menu lists Default and every offered level$/,
		run: async ({ world }) => {
			const options = effortOptions.get(world.page);
			if (!options) throw new Error("Effort options were not initialised");
			const menu = world.page.getByTestId("variant-dropdown");
			await expect(menu).toBeVisible();
			const rows = menu.getByRole("menuitemradio");
			await expect(rows).toHaveCount(options.length + 1);
			const actual = await rows.evaluateAll((items) =>
				items.map((item) =>
					item.getAttribute("data-testid")?.replace("variant-option-", ""),
				),
			);
			if (actual.join(", ") !== ["default", ...options].join(", ")) {
				throw new Error(`Unexpected effort menu order: ${actual.join(", ")}`);
			}
			for (const option of ["default", ...options]) {
				await expect(
					world.page
						.getByTestId(`variant-option-${option}`)
						.locator(".effort-meter > span"),
				).toHaveCount(options.length);
			}
			await expect(
				world.page.getByTestId("variant-option-default"),
			).toContainText("Default");
		},
	},
	{
		name: "assert effort level description",
		match: /^the effort option (\w+) describes (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`variant-option-${match[1]}`),
			).toContainText(match[2] ?? "");
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
