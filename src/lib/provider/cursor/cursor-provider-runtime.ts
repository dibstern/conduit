import { Effect } from "effect";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstanceDeps,
} from "../runner/runner-provider-instance.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionRunner,
} from "../runner/session-runner.js";
import type { TurnResult } from "../types.js";
import { makeCursorRunnerDriver } from "./cursor-runner-driver.js";

// Discovery never starts a runner. Turn preparation rejects before this boundary.
class CursorDiscoveryRunner implements SessionRunner {
	executeEffect(
		command: Extract<SessionCommand, { type: "send-turn" }>,
	): Effect.Effect<TurnResult, SessionFailure>;
	executeEffect(
		command: Exclude<SessionCommand, { type: "send-turn" }>,
	): Effect.Effect<void, SessionFailure>;
	executeEffect(
		command: SessionCommand,
	): Effect.Effect<TurnResult | undefined, SessionFailure>;
	executeEffect(
		command: SessionCommand,
	): Effect.Effect<TurnResult | undefined, SessionFailure> {
		return command.type === "send-turn"
			? Effect.fail({
					operation: "sendTurn",
					message: "Cursor turn preparation not installed",
				})
			: Effect.succeed(undefined);
	}
}

export const makeCursorProviderRuntime = (deps: RunnerProviderInstanceDeps) =>
	makeRunnerProviderInstance(deps, makeCursorRunnerDriver(), () =>
		Effect.succeed(new CursorDiscoveryRunner()),
	);
