import { Context, Effect, Option } from "effect";

// Signals and restart RPCs preserve runners during server disposal.
let restarting = false;

export interface ClaudeRunnerRollback {
	preserve: boolean;
	readonly fullStopRequested: Effect.Effect<boolean>;
}

export class ClaudeRunnerRollbackTag extends Context.Tag(
	"ClaudeRunnerRollback",
)<ClaudeRunnerRollbackTag, ClaudeRunnerRollback>() {}

export function setClaudeRunnerRestart(restart: boolean): void {
	restarting = restart;
}
export function preserveClaudeRunners(
	rollback?: ClaudeRunnerRollback,
): Effect.Effect<boolean> {
	return Effect.gen(function* () {
		const local =
			rollback ??
			Option.getOrUndefined(
				yield* Effect.serviceOption(ClaudeRunnerRollbackTag),
			);
		if (local === undefined) return restarting;
		const stop = yield* local.fullStopRequested;
		return !stop && (restarting || local.preserve);
	});
}
