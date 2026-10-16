import { Effect } from "effect";
import { makeProcessSessionRunner } from "../runner/process-session-runner.js";
import { connectRunner } from "../runner/runner-connection.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstanceDeps,
} from "../runner/runner-provider-instance.js";
import { makeCursorRunnerDriver } from "./cursor-runner-driver.js";

export const makeCursorProviderRuntime = (deps: RunnerProviderInstanceDeps) =>
	makeRunnerProviderInstance(deps, makeCursorRunnerDriver(), (emit) =>
		makeProcessSessionRunner(deps, emit, {
			driverKind: "cursor",
			connect: connectRunner,
			settingsDeferredCode: "cursor_settings_deferred",
			snapshotCommandSettings: () => ({}),
			warmCommand: (sessionId, _state, snapshot) => ({
				type: "pre-warm",
				sessionId,
				input: snapshot.input,
			}),
			sameAccountLogin: () => true,
			// Restart replay belongs to xqsg.6. Never re-send an uncertain turn.
			recoverCommands: () => Effect.succeed([]),
		}),
	);
