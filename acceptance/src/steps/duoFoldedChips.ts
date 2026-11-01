import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { settleTransitions } from "./shared.js";

const CHIPS = "#duo-chips";

export const duoFoldedChipsHandlers: StepHandler[] = [
	{
		name: "chip row absent",
		match: /^the chip row is absent$/,
		run: async ({ world }) => {
			await expect(world.page.locator(CHIPS)).toHaveCount(0);
		},
	},
	{
		// Reads what a sighted user sees on each target, and where each target sits.
		name: "chip row reads",
		match: /^the chip row reads (.+) across y (\d+) to (\d+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			await settleTransitions(page);
			const chips = page.locator(`${CHIPS} button`);
			await expect
				.poll(() =>
					chips.evaluateAll((buttons) =>
						buttons
							.filter((button) => button.getClientRects().length > 0)
							.map((button) => {
								const { top, bottom } = button.getBoundingClientRect();
								return {
									text: (button as HTMLElement).innerText
										.replace(/\s+/g, " ")
										.trim(),
									top: Math.round(top),
									bottom: Math.round(bottom),
								};
							}),
					),
				)
				.toEqual(
					(match[1] ?? "").split(", ").map((text) => ({
						text,
						top: Number(match[2]),
						bottom: Number(match[3]),
					})),
				);
		},
	},
	{
		name: "chip row folded into header marks",
		match: /^the chip row folds into the header's goal and tasks marks$/,
		run: async ({ world }) => {
			const page = world.page;
			await expect(page.locator(CHIPS)).toHaveCount(0);
			const subline = page.getByTestId("session-bar-subline");
			await expect(
				subline.getByTestId("session-bar-subline-goal"),
			).toBeVisible();
			await expect(subline.getByTestId("session-bar-subline-tasks")).toHaveText(
				"4",
			);
		},
	},
	{
		// The transcript's padding follows the header's measured height.
		name: "transcript clearance",
		match: /^the transcript clears the header at y (\d+)$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() =>
					world.page
						.locator("[style*='--phone-chrome-clearance']")
						.evaluate((element) =>
							(element as HTMLElement).style.getPropertyValue(
								"--phone-chrome-clearance",
							),
						),
				)
				.toBe(`${match[1]}px`);
		},
	},
];
