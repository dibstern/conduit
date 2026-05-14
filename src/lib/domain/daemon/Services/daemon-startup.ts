import { InstanceMgmtTag } from "./management-service.js";
// ─── Daemon Startup Effect Functions ─────────────────────────────────────────
// Effect-based startup sequence for the daemon. Handles crash counting,
// instance rehydration, instance probing, smart default detection, and
// auto-start. Each step uses error isolation — expected tagged errors are
// caught and logged; programming defects propagate to the supervisor.
//
// Error isolation policy:
//   - Effect.catchTag for specific expected errors (tagged)
//   - Programming defects (untagged) propagate up
//   - Effect.catchAll is NOT used

import { Context, Data, Effect, Layer, Ref } from "effect";
import { CrashCounter as CrashCounterImpl } from "../../../daemon/crash-counter.js";
import {
	type OpenCodeApiError,
	OpenCodeConnectionError,
} from "../../../errors.js";
import type { InstanceConfig } from "../../../shared-types.js";

import { type DaemonInstanceConfig, DaemonStateTag } from "./daemon-state.js";

// ─── Errors ────────────────────────────────────────────────────────────────

/** Fatal error when crash limit is exceeded — the only error that stops startup. */
export class CrashLimitExceeded extends Data.TaggedError("CrashLimitExceeded")<{
	count: number;
}> {}

// ─── CrashCounter service ──────────────────────────────────────────────────

/** Interface for crash counting — tracks consecutive crashes to detect boot loops. */
export interface CrashCounter {
	record(): Effect.Effect<{ count: number; shouldAbort: boolean }>;
	reset(): Effect.Effect<void>;
}

/** Context Tag for the CrashCounter service. */
export class CrashCounterTag extends Context.Tag("CrashCounter")<
	CrashCounterTag,
	CrashCounter
>() {}

/**
 * CrashCounterLive — Layer that wraps the imperative CrashCounter class
 * in the Effect CrashCounter service interface.
 * Uses counter.getTimestamps().length for count (per AP-9).
 */
export const CrashCounterLive: Layer.Layer<CrashCounterTag> = Layer.effect(
	CrashCounterTag,
	Effect.sync(() => {
		const counter = new CrashCounterImpl();
		return {
			record: () =>
				Effect.sync(() => {
					counter.record();
					return {
						count: counter.getTimestamps().length,
						shouldAbort: counter.shouldGiveUp(),
					};
				}),
			reset: () =>
				Effect.sync(() => {
					counter.reset();
				}),
		};
	}),
);

// ─── recordCrashCounter ────────────────────────────────────────────────────

/**
 * Record a crash and return whether the daemon should abort.
 * Calls `counter.record()` and returns the `shouldAbort` boolean.
 */
export const recordCrashCounter: Effect.Effect<
	boolean,
	never,
	CrashCounterTag
> = Effect.gen(function* () {
	const counter = yield* CrashCounterTag;
	const { shouldAbort } = yield* counter.record();
	return shouldAbort;
}).pipe(Effect.withSpan("recordCrashCounter"));

// ─── rehydrateInstances ────────────────────────────────────────────────────

/**
 * Rehydrate instances from persisted DaemonState.
 *
 * Reads instances from the DaemonState Ref and calls addInstance for each.
 * Error isolation:
 *   - InstanceLimitExceeded: logged, continues
 *   - OpenCodeConnectionError: logged, continues
 *   - Top-level catchTag for OpenCodeApiError
 * Concurrency: sequential ({ concurrency: 1 }) to avoid port conflicts.
 */
export const rehydrateInstances: Effect.Effect<
	void,
	never,
	DaemonStateTag | InstanceMgmtTag
> = Effect.gen(function* () {
	const stateRef = yield* DaemonStateTag;
	const state = yield* Ref.get(stateRef);
	const mgmt = yield* InstanceMgmtTag;

	yield* Effect.forEach(
		state.instances,
		(inst: DaemonInstanceConfig) =>
			Effect.try(() => {
				const config: InstanceConfig = {
					name: inst.name,
					port: inst.port,
					managed: inst.managed,
					...(inst.env != null && { env: inst.env }),
					...(inst.url != null && { url: inst.url }),
				};
				mgmt.addInstance(inst.id, config);
			}).pipe(
				Effect.catchTag("UnknownException", (e) => {
					// Check if the underlying cause is a tagged error we expect
					if (e.error instanceof OpenCodeConnectionError) {
						return Effect.logWarning(
							`Rehydration failed for instance ${inst.id}: ${e.error.message}`,
						);
					}
					if (
						e.error &&
						typeof e.error === "object" &&
						"_tag" in e.error &&
						(e.error as { _tag: string })._tag === "InstanceLimitExceeded"
					) {
						return Effect.logWarning(
							`Instance limit exceeded rehydrating ${inst.id}`,
						);
					}
					// Re-throw unexpected errors as defects
					return Effect.die(e.error);
				}),
				Effect.annotateLogs("instanceId", inst.id),
			),
		{ concurrency: 1, discard: true },
	);
}).pipe(
	Effect.catchTag("OpenCodeApiError" as never, (e: OpenCodeApiError) =>
		Effect.logWarning(`OpenCode API error during rehydration: ${e.message}`),
	),
	Effect.withSpan("rehydrateInstances"),
);

// ─── probeAndConvert ───────────────────────────────────────────────────────

/**
 * Probe unmanaged instances and convert unreachable ones to managed.
 * Requires HttpClient from @effect/platform.
 *
 * Placeholder — full implementation requires HttpClient wiring.
 */
export const probeAndConvert: Effect.Effect<
	void,
	never,
	DaemonStateTag | InstanceMgmtTag
> = Effect.gen(function* () {
	// Placeholder: reads instances, probes unmanaged ones via HTTP,
	// converts unreachable ones to managed.
	yield* Effect.logDebug("probeAndConvert: not yet wired (needs HttpClient)");
}).pipe(Effect.withSpan("probeAndConvert"));

// ─── detectSmartDefault ────────────────────────────────────────────────────

/**
 * Probe localhost:4096 for a running OpenCode instance.
 * Requires HttpClient from @effect/platform.
 *
 * Placeholder — full implementation requires HttpClient wiring.
 */
export const detectSmartDefault: Effect.Effect<void> = Effect.gen(function* () {
	yield* Effect.logDebug(
		"detectSmartDefault: not yet wired (needs HttpClient)",
	);
}).pipe(Effect.withSpan("detectSmartDefault"));

// ─── autoStartManagedDefault ───────────────────────────────────────────────

/**
 * Auto-start stopped managed instances.
 */
export const autoStartManagedDefault: Effect.Effect<
	void,
	never,
	DaemonStateTag | InstanceMgmtTag
> = Effect.gen(function* () {
	const stateRef = yield* DaemonStateTag;
	const state = yield* Ref.get(stateRef);
	const mgmt = yield* InstanceMgmtTag;

	yield* Effect.forEach(
		state.instances.filter((i) => i.managed),
		(inst: DaemonInstanceConfig) =>
			Effect.tryPromise(() => mgmt.startInstance(inst.id)).pipe(
				Effect.catchTag("UnknownException", (e) =>
					Effect.logWarning(
						`Failed to auto-start instance ${inst.id}: ${e.message}`,
					),
				),
				Effect.annotateLogs("instanceId", inst.id),
			),
		{ concurrency: 1, discard: true },
	);
}).pipe(Effect.withSpan("autoStartManagedDefault"));

// ─── runStartupSequence ────────────────────────────────────────────────────

/**
 * Orchestrator Effect that runs the full startup sequence.
 *
 * Steps (sequential):
 *   1. recordCrashCounter — abort if crash limit exceeded
 *   2. rehydrateInstances — restore persisted instances
 *   3. probeAndConvert — probe unmanaged instances
 *   4. detectSmartDefault — probe localhost:4096
 *   5. autoStartManagedDefault — start stopped managed instances
 *
 * Error type: CrashLimitExceeded (the only fatal error).
 * All other errors are caught and logged by individual steps.
 */
export const runStartupSequence: Effect.Effect<
	void,
	CrashLimitExceeded,
	CrashCounterTag | DaemonStateTag | InstanceMgmtTag
> = Effect.gen(function* () {
	// Step 1: Check crash counter
	const counter = yield* CrashCounterTag;
	const { count, shouldAbort } = yield* counter.record();
	if (shouldAbort) {
		return yield* new CrashLimitExceeded({ count });
	}

	// Step 2: Rehydrate instances
	yield* rehydrateInstances;

	// Step 3: Probe and convert unmanaged instances
	yield* probeAndConvert;

	// Step 4: Detect smart default
	yield* detectSmartDefault;

	// Step 5: Auto-start managed instances
	yield* autoStartManagedDefault;

	yield* Effect.logInfo("Startup sequence complete");
}).pipe(
	Effect.annotateLogs("phase", "startup"),
	Effect.withSpan("runStartupSequence"),
);
