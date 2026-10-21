import { makeProcessSessionRunner } from "../runner/process-session-runner.js";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import { connectClaudeRunner } from "./claude-runner-connection.js";
import { recoverClaudeRunnerCommands } from "./claude-runner-recovery.js";
import { CLAUDE_SETTINGS_REPLAY_DEFERRED } from "./claude-runner-settings.js";
import { normalizeClaudeLaunchInput } from "./claude-runner-wire.js";
import { sameClaudeLogin } from "./claude-sdk-env.js";

export { stopRegisteredRunners as stopRegisteredClaudeRunners } from "../runner/process-session-runner.js";

/** Daemon-side Claude launch policy; process lifetime belongs to the host. */
export const makeProcessClaudeSessionRunner = (
	deps: ClaudeSessionRunnerDeps,
	emit: Parameters<typeof makeProcessSessionRunner>[1],
) =>
	makeProcessSessionRunner(deps, emit, {
		driverKind: "claude",
		admitsRecoveredSends: true,
		connect: connectClaudeRunner,
		settingsDeferredCode: CLAUDE_SETTINGS_REPLAY_DEFERRED,
		snapshotCommandSettings: (snapshot) => ({
			claudeSettingsOverrides: snapshot?.claudeSettingsOverrides,
		}),
		warmCommand: (sessionId, state, snapshot) => {
			const {
				model,
				contextWindow,
				variant,
				permissionMode,
				resumeSessionAt: _rewindPoint,
				forkSession: _forkSession,
				clearInheritedGoal: _clearInheritedGoal,
				...launch
			} = snapshot.input;
			return {
				type: "pre-warm",
				sessionId,
				input: {
					...launch,
					...(state.liveConfiguration ?? {
						...(model ? { model } : {}),
						...(contextWindow ? { contextWindow } : {}),
						...(variant ? { variant } : {}),
						...(permissionMode ? { permissionMode } : {}),
					}),
					...(state.resumeSessionId
						? { resumeSessionId: state.resumeSessionId }
						: {}),
				},
				claudeSettingsOverrides: snapshot.claudeSettingsOverrides,
				shellEnv: snapshot.options.env ?? {},
				settingsSnapshot: snapshot,
			};
		},
		sameAccountLogin: (a, b) =>
			sameClaudeLogin(
				{
					...a,
					root: a.root,
					configDir: normalizeClaudeLaunchInput({ configDir: a.configDir })
						.configDir,
				},
				{
					...b,
					root: b.root,
					configDir: normalizeClaudeLaunchInput({ configDir: b.configDir })
						.configDir,
				},
			),
		recoverCommands: (
			sql,
			sessionId,
			connection,
			failTurn,
			closing,
			liveSession,
			resolveSinkId,
			sendTurn,
		) =>
			recoverClaudeRunnerCommands(
				sql,
				sessionId,
				connection,
				failTurn,
				closing,
				deps,
				liveSession,
				resolveSinkId,
				sendTurn,
			),
	});
