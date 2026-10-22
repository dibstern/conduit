import { Effect } from "effect";
import { ProviderStateEffectTag } from "../../persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
import { makeProcessSessionRunner } from "../runner/process-session-runner.js";
import { makeRunnerCommandRecovery } from "../runner/runner-command-recovery.js";
import { connectRunner } from "../runner/runner-connection.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstanceDeps,
} from "../runner/runner-provider-instance.js";
import { makeCursorRunnerDriver } from "./cursor-runner-driver.js";

export const makeCursorProviderRuntime = (deps: RunnerProviderInstanceDeps) =>
	Effect.gen(function* () {
		const read = yield* ReadQueryEffectTag;
		const state = yield* ProviderStateEffectTag;
		return yield* makeRunnerProviderInstance(
			deps,
			makeCursorRunnerDriver(
				deps.workspaceRoot,
				undefined,
				{ read, state },
				deps.daemonConfigDir,
			),
			(emit) =>
				makeProcessSessionRunner(deps, emit, {
					driverKind: "cursor",
					coldUpgrade: true,
					connect: connectRunner,
					settingsDeferredCode: "cursor_settings_deferred",
					snapshotCommandSettings: () => ({}),
					warmCommand: (sessionId, _state, snapshot) => ({
						type: "pre-warm",
						sessionId,
						input: snapshot.input,
					}),
					sameAccountLogin: () => true,
					recoverCommands: makeRunnerCommandRecovery({
						driverKind: "cursor",
						accounts: deps.accounts,
						state,
						providerStateKeys: ["cursor.forkDigest"],
					}),
				}),
		);
	});
