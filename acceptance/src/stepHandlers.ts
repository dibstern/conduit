import { PlaywrightDriver } from "./playwrightDriver.js";
import type { AcceptanceLifecycle, StepHandler } from "./runtime.js";
import { backgroundTasksHandlers } from "./steps/backgroundTasks.js";
import { claudeSettingsHandlers } from "./steps/claudeSettings.js";
import { composerHandlers } from "./steps/composer.js";
import { composerContextWarningHandlers } from "./steps/composerContextWarning.js";
import { composerEffortHandlers } from "./steps/composerEffort.js";
import { composerFieldWidthHandlers } from "./steps/composerFieldWidth.js";
import { composerLiveStatusHandlers } from "./steps/composerLiveStatus.js";
import { composerPickerHandlers } from "./steps/composerPicker.js";
import { composerSetGoalHandlers } from "./steps/composerSetGoal.js";
import { composerWordsHandlers } from "./steps/composerWords.js";
import { harnessHandlers } from "./steps/harness.js";
import { mockAppHandlers } from "./steps/mockApp.js";
import { modelDriftHandlers } from "./steps/modelDrift.js";
import { providerInstancesHandlers } from "./steps/providerInstances.js";
import { sessionGoalHandlers } from "./steps/sessionGoal.js";
import { sessionGoalDetailsHandlers } from "./steps/sessionGoalDetails.js";
import { sessionPresentationHandlers } from "./steps/sessionPresentation.js";
import { sessionSkillsHandlers } from "./steps/sessionSkills.js";
import { transcriptFeedHandlers } from "./steps/transcriptFeed.js";
import { visualHandlers } from "./steps/visual.js";

const driver = new PlaywrightDriver();

export const conduitVisualHandlers: StepHandler[] = [
	...sessionPresentationHandlers,
	...backgroundTasksHandlers,
	...sessionGoalDetailsHandlers,
	...sessionGoalHandlers,
	...sessionSkillsHandlers,
	...mockAppHandlers,
	...modelDriftHandlers,
	// Before composer: its "the transcript shows (.*)" would swallow the
	// feed's more specific "the transcript shows a loading skeleton".
	...transcriptFeedHandlers,
	...composerFieldWidthHandlers,
	...composerLiveStatusHandlers,
	...composerPickerHandlers,
	...composerWordsHandlers,
	...composerContextWarningHandlers,
	...composerHandlers,
	...composerEffortHandlers,
	...composerSetGoalHandlers,
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
