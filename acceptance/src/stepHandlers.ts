import { PlaywrightDriver } from "./playwrightDriver.js";
import type { AcceptanceLifecycle, StepHandler } from "./runtime.js";
import { claudeSettingsHandlers } from "./steps/claudeSettings.js";
import { composerHandlers } from "./steps/composer.js";
import { harnessHandlers } from "./steps/harness.js";
import { mockAppHandlers } from "./steps/mockApp.js";
import { modelDriftHandlers } from "./steps/modelDrift.js";
import { providerInstancesHandlers } from "./steps/providerInstances.js";
import { sessionPresentationHandlers } from "./steps/sessionPresentation.js";
import { visualHandlers } from "./steps/visual.js";

const driver = new PlaywrightDriver();

export const conduitVisualHandlers: StepHandler[] = [
	...sessionPresentationHandlers,
	...mockAppHandlers,
	...modelDriftHandlers,
	...composerHandlers,
	...harnessHandlers,
	...visualHandlers,
	...claudeSettingsHandlers,
	...providerInstancesHandlers,
];

export const conduitVisualLifecycle: AcceptanceLifecycle = {
	createWorld: async () => ({
		page: await driver.newExecution(),
		driver,
		artifacts: [],
	}),
	afterScenario: async ({ world, error }) => {
		if (error && world.artifacts.length > 0) {
			process.stderr.write(`Visual artifacts: ${world.artifacts.join(", ")}\n`);
		}
		await world.driver.closeExecution();
	},
	afterFeature: async () => {
		await driver.close();
	},
};
