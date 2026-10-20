/** Claude daemon launch composition; live SDK state belongs to the runner payload. */
import { join } from "node:path";
import { Context, Effect, Layer, Result, type Scope } from "effect";
import { accountsStateFromConfig } from "../../account-directory.js";
import {
	defaultDaemonConfig,
	loadDaemonConfigResult,
	resolveClaudeLaunchConfig,
} from "../../daemon/config-persistence.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstance,
} from "../runner/runner-provider-instance.js";
import { makeClaudeCapabilitiesService } from "./claude-capabilities-service.js";
import { makeProcessClaudeSessionRunner } from "./claude-process-session-runner.js";
import { makeClaudeRunnerDriver } from "./claude-runner-driver.js";
import type { ClaudeProviderInstanceDeps } from "./claude-runner-payload.js";
import { captureClaudeLaunchLogin } from "./claude-sdk-env.js";

export { RunnerProviderInstance as ClaudeProviderRuntime } from "../runner/runner-provider-instance.js";
export {
	type ClaudeProviderInstanceDeps,
	type ClaudeProviderRuntimeState,
	type ClaudeSessionRunnerDeps,
	makeClaudeSessionRunner,
} from "./claude-runner-payload.js";

export class ClaudeProviderRuntimeTag extends Context.Service<
	ClaudeProviderRuntimeTag,
	RunnerProviderInstance
>()("ClaudeProviderRuntime") {}

export const makeClaudeProviderRuntime = (
	deps: ClaudeProviderInstanceDeps,
): Effect.Effect<RunnerProviderInstance, never, Scope.Scope> =>
	Effect.gen(function* () {
		const capabilitiesService =
			deps.capabilitiesService ??
			(yield* makeClaudeCapabilitiesService({
				...(deps.daemonConfigDir !== undefined
					? {
							cacheDir: join(
								deps.daemonConfigDir,
								"cache",
								"claude-capabilities",
							),
						}
					: {}),
				launchConfig: () =>
					resolveClaudeLaunchConfig(
						Result.getOrElse(
							loadDaemonConfigResult(deps.daemonConfigDir),
							(error) => {
								if (error._tag === "NotFound") return null;
								throw error;
							},
						),
					),
			}));
		const driver = makeClaudeRunnerDriver({ ...deps, capabilitiesService });
		const accounts = Effect.suspend(() =>
			Effect.fromResult(loadDaemonConfigResult(deps.daemonConfigDir)),
		).pipe(
			Effect.catchTag("NotFound", () => Effect.succeed(defaultDaemonConfig())),
			Effect.map((config) =>
				accountsStateFromConfig(config, captureClaudeLaunchLogin(process.env)),
			),
		);
		return yield* makeRunnerProviderInstance(
			{
				...deps,
				accounts,
				...(deps.ensureClaudeSubagentSession
					? { ensureChildSession: deps.ensureClaudeSubagentSession }
					: {}),
				...(deps.readClaudeSubagentTranscript
					? { readSubagentTranscript: deps.readClaudeSubagentTranscript }
					: {}),
			},
			driver,
			(emit) =>
				(deps.runnerFactory ?? makeProcessClaudeSessionRunner)(
					{ ...deps, capabilitiesService },
					emit,
				),
		);
	});

export const ClaudeProviderRuntimeLive = (
	deps: ClaudeProviderInstanceDeps,
): Layer.Layer<ClaudeProviderRuntimeTag, never, Scope.Scope> =>
	Layer.effect(ClaudeProviderRuntimeTag, makeClaudeProviderRuntime(deps));
