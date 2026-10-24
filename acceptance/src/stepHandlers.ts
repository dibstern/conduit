import { PlaywrightDriver } from "./playwrightDriver.js";
import type { AcceptanceLifecycle, StepHandler } from "./runtime.js";
import { addProjectDialogHandlers } from "./steps/addProjectDialog.js";
import { askContextHandlers } from "./steps/askContext.js";
import { backgroundTasksHandlers } from "./steps/backgroundTasks.js";
import { claudeSettingsHandlers } from "./steps/claudeSettings.js";
import { codexAsyncQuestionHandlers } from "./steps/codexAsyncQuestion.js";
import { composerHandlers } from "./steps/composer.js";
import { composerAccountsHandlers } from "./steps/composerAccounts.js";
import { composerContextWarningHandlers } from "./steps/composerContextWarning.js";
import { composerEffortHandlers } from "./steps/composerEffort.js";
import { composerFieldWidthHandlers } from "./steps/composerFieldWidth.js";
import { composerFilesHandlers } from "./steps/composerFiles.js";
import { composerFinalDesignHandlers } from "./steps/composerFinalDesign.js";
import { composerLiveStatusHandlers } from "./steps/composerLiveStatus.js";
import { composerPickerHandlers } from "./steps/composerPicker.js";
import { composerSendAtResetHandlers } from "./steps/composerSendAtReset.js";
import { composerSetGoalHandlers } from "./steps/composerSetGoal.js";
import { composerWordsHandlers } from "./steps/composerWords.js";
import { cursorAuthHandlers } from "./steps/cursorAuth.js";
import { cursorForkHandlers } from "./steps/cursorFork.js";
import { cursorModelParametersHandlers } from "./steps/cursorModelParameters.js";
import { cursorQuestionHandlers } from "./steps/cursorQuestion.js";
import { cursorSkillsHandlers } from "./steps/cursorSkills.js";
import { cursorSteerHandlers } from "./steps/cursorSteer.js";
import { cursorSubagentsHandlers } from "./steps/cursorSubagents.js";
import { cursorToolsHandlers } from "./steps/cursorTools.js";
import { cursorTurnHandlers } from "./steps/cursorTurn.js";
import { cursorUsageHandlers } from "./steps/cursorUsage.js";
import { cursorUsageErrorsHandlers } from "./steps/cursorUsageErrors.js";
import { draftAttachmentFailureHandlers } from "./steps/draftAttachmentFailures.js";
import { firstRunProjectsHandlers } from "./steps/firstRunProjects.js";
import { harnessHandlers } from "./steps/harness.js";
import { launchingRowsHandlers } from "./steps/launchingRows.js";
import { mockAppHandlers } from "./steps/mockApp.js";
import { modelDriftHandlers } from "./steps/modelDrift.js";
import { opencodeConnectionBannerHandlers } from "./steps/opencodeConnectionBanner.js";
import { pendingInputTrayHandlers } from "./steps/pendingInputTray.js";
import { phoneToastsHandlers } from "./steps/phoneToasts.js";
import { projectTreeHandlers } from "./steps/projectTree.js";
import { providerInstancesHandlers } from "./steps/providerInstances.js";
import { sessionAutoSettleHandlers } from "./steps/sessionAutoSettle.js";
import { sessionGoalHandlers } from "./steps/sessionGoal.js";
import { sessionGoalDetailsHandlers } from "./steps/sessionGoalDetails.js";
import { sessionModeDefaultHandlers } from "./steps/sessionModeDefault.js";
import { sessionPresentationHandlers } from "./steps/sessionPresentation.js";
import { sessionRowsHandlers } from "./steps/sessionRows.js";
import { sessionSheetSnoozeHandlers } from "./steps/sessionSheetSnooze.js";
import { sessionSheetsHandlers } from "./steps/sessionSheets.js";
import { sessionSkillsHandlers } from "./steps/sessionSkills.js";
import { settingsGeneralHandlers } from "./steps/settingsGeneral.js";
import { settingsSurfacingHandlers } from "./steps/settingsSurfacing.js";
import { sideThreadsHandlers } from "./steps/sideThreads.js";
import { surfacingCardHandlers } from "./steps/surfacingCard.js";
import { surfacingMarksHandlers } from "./steps/surfacingMarks.js";
import { surfacingMinimiseHandlers } from "./steps/surfacingMinimise.js";
import { surfacingRecapHandlers } from "./steps/surfacingRecap.js";
import { surfacingReplyHandlers } from "./steps/surfacingReply.js";
import { surfacingSwitchesHandlers } from "./steps/surfacingSwitches.js";
import { surfacingTuningHandlers } from "./steps/surfacingTuning.js";
import { taskDrillInHandlers } from "./steps/taskDrillIn.js";
import { terminalKeysHandlers } from "./steps/terminalKeys.js";
import { terminalSettingsHandlers } from "./steps/terminalSettings.js";
import { themeMenuHandlers } from "./steps/themeMenu.js";
import { titleGenerationSettingsHandlers } from "./steps/titleGenerationSettings.js";
import { transcriptFeedHandlers } from "./steps/transcriptFeed.js";
import { usageFooterMeterHandlers } from "./steps/usageFooterMeter.js";
import { usageLimitStripHandlers } from "./steps/usageLimitStrip.js";
import { usageSettingsHandlers } from "./steps/usageSettings.js";
import { usageWarningStripHandlers } from "./steps/usageWarningStrip.js";
import { userAvatarHandlers } from "./steps/userAvatar.js";
import { visualHandlers } from "./steps/visual.js";
import { worktreeCleanupSettingsHandlers } from "./steps/worktreeCleanupSettings.js";

const driver = new PlaywrightDriver();

export const conduitVisualHandlers: StepHandler[] = [
	...addProjectDialogHandlers,
	...firstRunProjectsHandlers,
	...draftAttachmentFailureHandlers,
	...sessionPresentationHandlers,
	...sessionSheetsHandlers,
	...sessionSheetSnoozeHandlers,
	...sessionAutoSettleHandlers,
	...phoneToastsHandlers,
	...sessionRowsHandlers,
	...projectTreeHandlers,
	...sessionModeDefaultHandlers,
	...backgroundTasksHandlers,
	...launchingRowsHandlers,
	...taskDrillInHandlers,
	...terminalKeysHandlers,
	...terminalSettingsHandlers,
	...themeMenuHandlers,
	...titleGenerationSettingsHandlers,
	...sideThreadsHandlers,
	...surfacingCardHandlers,
	...surfacingMarksHandlers,
	...surfacingMinimiseHandlers,
	...surfacingRecapHandlers,
	...surfacingSwitchesHandlers,
	...surfacingReplyHandlers,
	...askContextHandlers,
	...surfacingTuningHandlers,
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
	...cursorModelParametersHandlers,
	...cursorQuestionHandlers,
	...codexAsyncQuestionHandlers,
	...cursorSkillsHandlers,
	...cursorSteerHandlers,
	...cursorTurnHandlers,
	...cursorForkHandlers,
	...cursorAuthHandlers,
	...cursorToolsHandlers,
	...cursorSubagentsHandlers,
	...cursorUsageErrorsHandlers,
	...cursorUsageHandlers,
	...opencodeConnectionBannerHandlers,
	// Before composer: its "the transcript shows (.*)" would swallow the
	// feed's more specific "the transcript shows a loading skeleton".
	...transcriptFeedHandlers,
	...composerFieldWidthHandlers,
	...composerFilesHandlers,
	...composerFinalDesignHandlers,
	...composerLiveStatusHandlers,
	...pendingInputTrayHandlers,
	...composerPickerHandlers,
	...composerAccountsHandlers,
	...composerWordsHandlers,
	...composerContextWarningHandlers,
	...settingsGeneralHandlers,
	...userAvatarHandlers,
	...settingsSurfacingHandlers,
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
