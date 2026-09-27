import type { CrashCounterTag } from "../Services/daemon-startup.js";
import type { DaemonStateTag } from "../Services/daemon-state.js";
import type {
	InstanceMgmtTag,
	ProjectMgmtTag,
} from "../Services/management-service.js";
// ─── Daemon Main — Effect Entry Point ────────────────────────────────────────
// Top-level Effect program that replaces the Daemon class's start() method.
// Creates a Layer that runs the startup sequence, forks background tasks
// under supervision, and keeps alive until interrupted (SIGINT/SIGTERM).
//
// Phase 1: Only projectDiscovery is forked. Session prefetch and push init
// are stubbed as comments for Phase 2 expansion.
//
// Design points:
//   - Layer.scopedDiscard — side-effect-only Layer (no output service)
//   - Effect.forkScoped — fibers tied to enclosing scope, interrupted on shutdown
//   - Effect.tapDefect — logs defects without swallowing them
//   - Effect.never — keeps the fiber alive until SIGINT/SIGTERM
//   - Layer.provide(daemonLayer) — provides all deps to the program

import type { Fiber } from "effect";
import {
	Context,
	Data,
	Effect,
	Layer,
	RuntimeFlags,
	RuntimeFlagsPatch,
	Schedule,
	Supervisor,
} from "effect";
import {
	type CrashLimitExceeded,
	projectDiscovery,
	runStartupSequence,
} from "../Services/daemon-startup.js";
import { OpenCodeUnavailableError } from "../Services/opencode-smart-default.js";

export { resolveDefaultStaticDir } from "../Services/daemon-static-dir.js";
export { OpenCodeUnavailableError };

// ─── SupervisorTag ───────────────────────────────────────────────────────
// Context.Tag for the daemon-wide Supervisor.track instance.
// Allows any fiber in the daemon scope to query tracked fiber diagnostics.

export class SupervisorTag extends Context.Tag("DaemonSupervisor")<
	SupervisorTag,
	Supervisor.Supervisor<Array<Fiber.RuntimeFiber<unknown, unknown>>>
>() {}

/**
 * Live Layer that creates a Supervisor.track instance and provides it
 * via SupervisorTag. Use `Layer.provide(makeSupervisorLive)` to make
 * the supervisor available to the daemon program.
 */
export const makeSupervisorLive: Layer.Layer<SupervisorTag> = Layer.effect(
	SupervisorTag,
	Supervisor.track,
);

// ─── DaemonDeps type ──────────────────────────────────────────────────────
// Minimal at Phase 1, listing only Tags available from Tasks 1-5.
// DO NOT import Tags from Phase 2+ modules.

export type DaemonDeps =
	| DaemonStateTag
	| CrashCounterTag
	| InstanceMgmtTag
	| ProjectMgmtTag;

// ─── Retry schedule ───────────────────────────────────────────────────────

/** Exponential backoff with 3 retries for startup. */
export const startupRetry = Schedule.exponential("1 second").pipe(
	Schedule.intersect(Schedule.recurs(3)),
);

// ── sessionPrefetch — STUB (Phase 2a) ──
// export const sessionPrefetch: Effect.Effect<void, never, ...> = ...

// ── pushInit — STUB (Phase 2b) ──
// export const pushInit: Effect.Effect<void, never, ...> = ...

// ─── makeDaemonProgramLayer ───────────────────────────────────────────────

/**
 * Takes a Layer providing all DaemonDeps and returns a Layer<never> that:
 *   1. Enables cooperative yielding
 *   2. Runs the startup sequence with retry and CrashLimitExceeded handling
 *   3. Forks background tasks under supervision
 *   4. Keeps alive until interrupted
 *
 * The returned Layer is meant to be the outermost layer in the daemon
 * runtime — `Layer.launch(makeDaemonProgramLayer(daemonLayer))`.
 */
export const makeDaemonProgramLayer = (
	daemonLayer: Layer.Layer<DaemonDeps>,
): Layer.Layer<never> =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			// Enable cooperative yielding so long-running effects yield to siblings
			yield* Effect.withRuntimeFlagsPatchScoped(
				RuntimeFlagsPatch.enable(RuntimeFlags.CooperativeYielding),
			);

			// Run startup sequence with retry and crash-limit handling
			yield* runStartupSequence.pipe(
				Effect.retry(startupRetry),
				Effect.withSpan("daemon.startup"),
				Effect.catchTag("CrashLimitExceeded", (e: CrashLimitExceeded) =>
					Effect.logError(
						`Daemon aborting: crash limit exceeded (${e.count} consecutive crashes)`,
					).pipe(Effect.andThen(Effect.die(e))),
				),
			);

			// Fork background tasks under supervision (supervisor from context)
			const supervisor = yield* SupervisorTag;
			yield* Effect.supervised(
				Effect.gen(function* () {
					yield* Effect.forkScoped(projectDiscovery);
					// yield* Effect.forkScoped(sessionPrefetch);  // EXPAND Phase 2a
					// yield* Effect.forkScoped(pushInit);          // EXPAND Phase 2b
				}),
				supervisor,
			).pipe(
				Effect.tapDefect((defect) =>
					Effect.logError("DEFECT in background task — this is a bug", {
						defect,
					}),
				),
			);

			yield* Effect.logInfo("Daemon started — awaiting interruption");
			yield* Effect.never; // Keep alive until interrupted
		}).pipe(Effect.annotateLogs("component", "daemon-main")),
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
