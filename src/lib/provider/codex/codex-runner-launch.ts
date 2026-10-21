import { Effect } from "effect";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import type {
	RunnerLaunch,
	RunnerLaunchCallbacks,
} from "../runner/runner-host.js";
import { makeCodexSessionRunner } from "./codex-runner-payload.js";

export const makeCodexRunnerLaunch = (
	callbacks: RunnerLaunchCallbacks,
): Effect.Effect<RunnerLaunch> => {
	let resumeSessionId: string | undefined;
	let environment: Readonly<Record<string, string | undefined>> = process.env;
	return Effect.succeed({
		makeRunner: (config, emit) =>
			makeCodexSessionRunner(
				{
					workspaceRoot: config.workspaceRoot,
					daemonConfigDir: config.daemonConfigDir ?? DEFAULT_CONFIG_DIR,
					environment: () => environment,
				},
				emit,
			),
		upgradeState: () => ({ ...(resumeSessionId ? { resumeSessionId } : {}) }),
		acceptCommand: (command) => {
			if (command.type === "send-turn")
				environment = command.shellEnv ?? process.env;
		},
		executeEffect: (runner, command) =>
			Effect.gen(function* () {
				const result = yield* runner.executeEffect(command);
				resumeSessionId =
					(yield* runner.getResumeSessionIdEffect?.(callbacks.sessionId) ??
						Effect.succeed(undefined)) ?? undefined;
				callbacks.stateChanged();
				return result;
			}),
	});
};
