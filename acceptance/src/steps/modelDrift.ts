import type { StepHandler } from "../runtime.js";

export const modelDriftHandlers: StepHandler[] = [
	{
		name: "assert composer model drift text",
		match: /^the composer model drift indicator reads (.+)$/,
		run: async ({ world, match }) => {
			const expected = match[1] ?? "";
			await world.page.waitForFunction(
				(text) =>
					document
						.querySelector('[data-testid="current-model-drift"]')
						?.textContent?.trim() === text,
				expected,
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "assert turn model drift text",
		match: /^the turn model drift marker reads (.+)$/,
		run: async ({ world, match }) => {
			const expected = match[1] ?? "";
			await world.page.waitForFunction(
				(text) =>
					document
						.querySelector('[data-testid="turn-model-drift"]')
						?.textContent?.trim() === text,
				expected,
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "assert composer model drift absent",
		match: /^no composer model drift indicator is rendered$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("current-model-drift")
				.waitFor({ state: "detached", timeout: 2_000 });
		},
	},
	{
		name: "assert turn model drift absent",
		match: /^no turn model drift marker is rendered$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("turn-model-drift")
				.waitFor({ state: "detached", timeout: 2_000 });
		},
	},
];
