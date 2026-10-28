import type { StepHandler } from "../runtime.js";
import { currentVisualMode } from "../visualMode.js";

/** Visual regions that aren't addressed by a bare element id. Any other region
 *  name resolves to `#<name>`. */
const REGION_SELECTORS: Record<string, string> = {
	composer: "#input-area",
	"last-user-message": "#messages .msg-user >> nth=-1",
	// Menus portal to <body>, so a sheet or popover is only inside the whole screen.
	screen: "body",
	"terminal-tab-bar": "#terminal-panel .term-tab-bar",
	"terminal-keys-menu": '[role="menu"][aria-label="Terminal keys"]',
	"terminal-key-row": "#terminal-panel .term-key-row",
	"session-sheet":
		'[data-testid="session-bar-island-menu"], [data-testid="session-action-sheet"]',
};

/** The step text carries the threshold, whether written literally or filled
 *  from an Examples column, so a plain Scenario needs no table. */
function parseThreshold(value: string | undefined): number {
	const threshold = Number(value);
	if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
		throw new Error(`Malformed visual threshold: ${value}`);
	}
	return threshold;
}

export const visualHandlers: StepHandler[] = [
	{
		name: "visually match region",
		match:
			/^the ([a-z0-9-]+) region visually matches ([a-z0-9-]+) at ([0-9]+(?:\.[0-9]+)?) percent$/,
		run: async ({ world, match }) => {
			const regionId = match[1] ?? "";
			// The step text, so one scenario can compare several named states.
			const baseline = match[2] ?? "";
			const mode = currentVisualMode(baseline);
			if (mode === "skip") return;
			const threshold = parseThreshold(match[3]);
			const result = await world.driver.matchRegion(
				world.page,
				regionId,
				REGION_SELECTORS[regionId] ?? `#${regionId}`,
				baseline,
				threshold,
				mode,
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
