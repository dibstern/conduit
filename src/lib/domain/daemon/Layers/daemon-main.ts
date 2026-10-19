import type { DaemonStateTag } from "../Services/daemon-state.js";
import type { InstanceMgmtTag } from "../Services/management-service.js";
// Top-level Effect program that replaces the Daemon class's start() method.
// Creates a scoped Layer that runs startup and keeps alive until interrupted.
//
// Design points:
//   - Layer.effectDiscard — side-effect-only Layer (no output service)
//   - Effect.tapDefect — logs defects without swallowing them
//   - Effect.never — keeps the fiber alive until SIGINT/SIGTERM
//   - Layer.provide(daemonLayer) — provides all deps to the program

import {
	Context,
	Data,
	Effect,
	FiberSet,
	Layer,
	References,
	Schedule,
} from "effect";
import { runStartupSequence } from "../Services/daemon-startup.js";
import { OpenCodeUnavailableError } from "../Services/opencode-smart-default.js";

export { resolveDefaultStaticDir } from "../Services/daemon-static-dir.js";
export { OpenCodeUnavailableError };

// Explicit fiber tracking replaces the removed ambient supervisor.
export class SupervisorTag extends Context.Service<
	SupervisorTag,
	FiberSet.FiberSet<unknown, unknown>
>()("DaemonSupervisor") {}

/**
 * Live Layer that creates a scoped FiberSet and provides it
 * via SupervisorTag. Use `Layer.provide(makeSupervisorLive)` to make
 * the supervisor available to the daemon program.
 */
export const makeSupervisorLive: Layer.Layer<SupervisorTag> = Layer.effect(
	SupervisorTag,
	FiberSet.make(),
);

// Minimal: lists only the Tags used by the current startup sequence.
// Do not import Tags for background tasks that are still stubs.

export type DaemonDeps = DaemonStateTag | InstanceMgmtTag;

/** Exponential backoff with 3 retries for startup. */
export const startupRetry = Schedule.max([
	Schedule.exponential("1 second"),
	Schedule.recurs(3),
]);

// export const sessionPrefetch: Effect.Effect<void, never, ...> = ...

// export const pushInit: Effect.Effect<void, never, ...> = ...

/**
 * Takes a Layer providing all DaemonDeps and returns a Layer<never> that:
 *   1. Enables cooperative yielding
 *   2. Runs the startup sequence with retry
 *   3. Forks background tasks under supervision
 *   4. Keeps alive until interrupted
 *
 * The returned Layer is meant to be the outermost layer in the daemon
 * runtime — `Layer.launch(makeDaemonProgramLayer(daemonLayer))`.
 */
export const makeDaemonProgramLayer = (
	daemonLayer: Layer.Layer<DaemonDeps>,
): Layer.Layer<never> =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			// Run startup sequence with retry
			yield* runStartupSequence.pipe(
				Effect.retry(startupRetry),
				Effect.withSpan("daemon.startup"),
			);

			yield* Effect.logInfo("Daemon started — awaiting interruption");
			yield* Effect.never; // Keep alive until interrupted
		}).pipe(
			Effect.provideService(References.PreventSchedulerYield, false),
			Effect.annotateLogs("component", "daemon-main"),
		),
	).pipe(Layer.provide(Layer.merge(daemonLayer, makeSupervisorLive)));

export {
	DaemonHandleTag,
	type EffectDaemonHandle,
} from "../Services/daemon-handle.js";

export class DaemonLifecycleContextUnavailableError extends Data.TaggedError(
	"DaemonLifecycleContextUnavailableError",
)<{
	readonly operation: string;
}> {
	override get message(): string {
		return "Daemon lifecycle context is not available before the daemon Layer has started";
	}
}
