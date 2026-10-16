import { PlaywrightDriver } from "./playwrightDriver.js";
import type { AcceptanceLifecycle, StepHandler } from "./runtime.js";
import { backgroundTasksHandlers } from "./steps/backgroundTasks.js";
import { claudeSettingsHandlers } from "./steps/claudeSettings.js";
import { composerHandlers } from "./steps/composer.js";
import { composerAccountsHandlers } from "./steps/composerAccounts.js";
import { composerContextWarningHandlers } from "./steps/composerContextWarning.js";
import { composerEffortHandlers } from "./steps/composerEffort.js";
import { composerFieldWidthHandlers } from "./steps/composerFieldWidth.js";
import { composerFinalDesignHandlers } from "./steps/composerFinalDesign.js";
import { composerLiveStatusHandlers } from "./steps/composerLiveStatus.js";
import { composerPickerHandlers } from "./steps/composerPicker.js";
import { composerSendAtResetHandlers } from "./steps/composerSendAtReset.js";
import { composerSetGoalHandlers } from "./steps/composerSetGoal.js";
import { composerWordsHandlers } from "./steps/composerWords.js";
import { cursorSkillsHandlers } from "./steps/cursorSkills.js";
import { cursorToolsHandlers } from "./steps/cursorTools.js";
import { cursorTurnHandlers } from "./steps/cursorTurn.js";
import { cursorUsageErrorsHandlers } from "./steps/cursorUsageErrors.js";
import { harnessHandlers } from "./steps/harness.js";
import { launchingRowsHandlers } from "./steps/launchingRows.js";
import { mockAppHandlers } from "./steps/mockApp.js";
import { modelDriftHandlers } from "./steps/modelDrift.js";
import { opencodeConnectionBannerHandlers } from "./steps/opencodeConnectionBanner.js";
import { pendingInputTrayHandlers } from "./steps/pendingInputTray.js";
import { providerInstancesHandlers } from "./steps/providerInstances.js";
import { sessionGoalHandlers } from "./steps/sessionGoal.js";
import { sessionGoalDetailsHandlers } from "./steps/sessionGoalDetails.js";
import { sessionModeDefaultHandlers } from "./steps/sessionModeDefault.js";
import { sessionPresentationHandlers } from "./steps/sessionPresentation.js";
import { sessionRowsHandlers } from "./steps/sessionRows.js";
import { sessionSkillsHandlers } from "./steps/sessionSkills.js";
import { settingsGeneralHandlers } from "./steps/settingsGeneral.js";
import { sideThreadsHandlers } from "./steps/sideThreads.js";
import { taskDrillInHandlers } from "./steps/taskDrillIn.js";
import { transcriptFeedHandlers } from "./steps/transcriptFeed.js";
import { usageFooterMeterHandlers } from "./steps/usageFooterMeter.js";
import { usageLimitStripHandlers } from "./steps/usageLimitStrip.js";
import { usageSettingsHandlers } from "./steps/usageSettings.js";
import { usageWarningStripHandlers } from "./steps/usageWarningStrip.js";
import { visualHandlers } from "./steps/visual.js";
import { worktreeCleanupSettingsHandlers } from "./steps/worktreeCleanupSettings.js";

const driver = new PlaywrightDriver();

export const conduitVisualHandlers: StepHandler[] = [
	...sessionPresentationHandlers,
	...sessionRowsHandlers,
	...sessionModeDefaultHandlers,
	...backgroundTasksHandlers,
	...launchingRowsHandlers,
	...taskDrillInHandlers,
	...sideThreadsHandlers,
	...sessionGoalDetailsHandlers,
	...sessionGoalHandlers,
	...sessionSkillsHandlers,
	...mockAppHandlers,
	...modelDriftHandlers,
	...usageLimitStripHandlers,
	...usageFooterMeterHandlers,
	...usageSettingsHandlers,
	...usageWarningStripHandlers,
	...composerSendAtResetHandlers,
	...cursorSkillsHandlers,
	...cursorTurnHandlers,
	...cursorToolsHandlers,
	...cursorUsageErrorsHandlers,
	...opencodeConnectionBannerHandlers,
	// Before composer: its "the transcript shows (.*)" would swallow the
	// feed's more specific "the transcript shows a loading skeleton".
	...transcriptFeedHandlers,
	...composerFieldWidthHandlers,
	...composerFinalDesignHandlers,
	...composerLiveStatusHandlers,
	...pendingInputTrayHandlers,
	...composerPickerHandlers,
	...composerAccountsHandlers,
	...composerWordsHandlers,
	...composerContextWarningHandlers,
	...settingsGeneralHandlers,
	...worktreeCleanupSettingsHandlers,
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
