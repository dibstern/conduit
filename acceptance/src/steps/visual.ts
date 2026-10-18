import type { StepHandler } from "../runtime.js";
import { currentVisualMode } from "../visualMode.js";
import { exampleValue } from "./shared.js";

/** Visual regions that aren't addressed by a bare element id. Any other region
 *  name resolves to `#<name>`. */
const REGION_SELECTORS: Record<string, string> = {
	composer: "#input-area",
	"last-user-message": "#messages .msg-user >> nth=-1",
	// Menus portal to <body>, so a sheet or popover is only inside the whole screen.
	screen: "body",
	"terminal-tab-bar": "#terminal-panel .term-tab-bar",
	"session-sheet":
		'[data-testid="session-bar-island-menu"], [data-testid="session-action-sheet"]',
};

function thresholdExampleValue(
	example: Record<string, string>,
	key: string,
): number {
	const value = exampleValue(example, key);
	const threshold = Number(value);
	if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
		throw new Error(`Malformed visual threshold for <${key}>: ${value}`);
	}
	return threshold;
}

export const visualHandlers: StepHandler[] = [
	{
		name: "visually match region",
		match:
			/^the ([a-z0-9-]+) region visually matches ([a-z0-9-]+) at ([0-9]+(?:\.[0-9]+)?) percent$/,
		run: async ({ world, match, example }) => {
			const regionId = match[1] ?? "";
			// The step text, so one scenario can compare several named states.
			const baseline = match[2] ?? "";
			const threshold = thresholdExampleValue(example, "threshold");
			const result = await world.driver.matchRegion(
				world.page,
				regionId,
				REGION_SELECTORS[regionId] ?? `#${regionId}`,
				baseline,
				threshold,
				currentVisualMode(baseline),
			);
			if (result.actualPath) world.artifacts.push(result.actualPath);
			if (result.diffPath) world.artifacts.push(result.diffPath);
			if (!result.matches) {
				throw new Error(
					`Visual match failed for ${baseline}: ${(result.diffRatio * 100).toFixed(2)}% of pixels differ. Artifacts: ${world.artifacts.join(", ")}`,
				);
			}
		},
	},
];
