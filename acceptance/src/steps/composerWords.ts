import { expect } from "@playwright/test";
import { claudeBoundSessionMessages } from "../../../test/e2e/fixtures/mockup-state.js";
import type { StepHandler } from "../runtime.js";
import { seedComposerPickerCatalog } from "./composerPicker.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

export const composerWordsHandlers: StepHandler[] = [
	{
		name: "open settings to composer tab",
		match: /^I open settings to the Composer tab$/,
		run: async ({ world }) => {
			await world.page.evaluate(() =>
				window.dispatchEvent(new CustomEvent("settings:open")),
			);
			await expect(world.page.locator("#settings-panel")).toBeVisible();
			await world.page.getByTestId("settings-tab-composer").click();
			await expect(
				world.page.getByTestId("settings-composer-controls-icons"),
			).toHaveAttribute("aria-checked", "true");
		},
	},
	{
		name: "choose Words composer controls",
		match: /^I choose Words for composer controls$/,
		run: async ({ world }) => {
			const words = world.page.getByTestId("settings-composer-controls-words");
			await words.click();
			await expect(words).toHaveAttribute("aria-checked", "true");
			await expect
				.poll(() =>
					world.page.evaluate(() => {
						const stored = localStorage.getItem("conduit-composer-preferences");
						return stored
							? (JSON.parse(stored) as { controls?: unknown }).controls
							: null;
					}),
				)
				.toBe("words");
			await world.page.getByTestId("settings-close-btn").click();
			await expect(world.page.locator("#settings-panel")).toBeHidden();
		},
	},
	{
		name: "reload Words composer with its mock session and catalog",
		match: /^I reload the Words composer$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const previousRequests = rpc.getRequests().length;
			await world.page.reload();
			await expect(world.page.locator("#connect-overlay")).toBeHidden();
			await expect(world.page.locator("#input")).toBeVisible();
			await expect
				.poll(() => {
					const requests = rpc.getRequests().slice(previousRequests);
					return ["ViewSession", "GetModels"].every((tag) =>
						requests.some((request) => request.tag === tag),
					);
				})
				.toBe(true);
			// Reapply relay fixtures after navigation; leave the persisted preference alone.
			await requireRelayControl(world.page).sendMessages(
				claudeBoundSessionMessages,
			);
			await seedComposerPickerCatalog(world.page, "Claude");
		},
	},
	{
		name: "assert composer Words controls",
		match: /^the composer words row shows (.+), (\w+), (\w+) and (\w+)$/,
		run: async ({ world, match }) => {
			const row = world.page
				.locator("#input-area")
				.getByTestId("composer-words-row");
			await expect(row).toBeVisible();
			for (const [id, label] of [
				["composer-word-model", match[1]],
				["composer-word-context", match[2]],
				["composer-word-effort", match[3]],
				["composer-word-approvals", match[4]],
			] as const) {
				const control = row.getByTestId(id);
				await expect(control).toHaveText(label ?? "");
				await expect(control).not.toHaveAttribute("aria-busy", "true");
				await expect(control.locator("svg")).toHaveCount(
					id === "composer-word-model" ? 1 : 0,
				);
			}
		},
	},
	{
		name: "assert composer icon controls are absent",
		match: /^the composer icon controls are absent$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.locator("#input-area")
					.getByTestId(
						/^(model-picker-trigger|variant-badge|permission-mode-badge)$/,
					),
			).toHaveCount(0);
		},
	},
	{
		name: "assert Words row sits below the bordered composer",
		match: /^the words row is below the composer border$/,
		run: async ({ world }) => {
			await expect
				.poll(() =>
					world.page.locator("#input-area").evaluate((area) => {
						const border = area.querySelector("#input-row");
						const row = area.querySelector(
							'[data-testid="composer-words-row"]',
						);
						if (!border || !row || border.contains(row)) return false;
						const borderBox = border.getBoundingClientRect();
						const rowBox = row.getBoundingClientRect();
						const areaBox = area.getBoundingClientRect();
						return (
							rowBox.height > 0 &&
							rowBox.top >= borderBox.bottom &&
							rowBox.bottom <= areaBox.bottom &&
							rowBox.left >= areaBox.left &&
							rowBox.right <= areaBox.right
						);
					}),
				)
				.toBe(true);
		},
	},
];
