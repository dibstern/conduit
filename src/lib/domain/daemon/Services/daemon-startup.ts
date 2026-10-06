import { InstanceMgmtTag } from "./management-service.js";
// Effect-based startup sequence for the daemon. Handles instance
// rehydration, instance probing and smart default detection. Each step
// uses error isolation — expected tagged errors are caught and logged;
// programming defects propagate to the supervisor.
//
// Error isolation policy:
//   - Effect.catchTag for specific expected errors (tagged)
//   - Programming defects (untagged) propagate up
//   - Effect.catchAll is NOT used

import { Data, Effect, Ref } from "effect";
import {
	type OpenCodeApiError,
	OpenCodeConnectionError,
} from "../../../errors.js";
import type { InstanceConfig } from "../../../shared-types.js";

import { type DaemonInstanceConfig, DaemonStateTag } from "./daemon-state.js";

class InstanceRehydrationFailed extends Data.TaggedError(
	"InstanceRehydrationFailed",
)<{
	readonly instanceId: string;
	readonly cause: unknown;
}> {}

const isTaggedInstanceLimitExceeded = (cause: unknown): boolean =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	(cause as { _tag: string })._tag === "InstanceLimitExceeded";

const expectedInstanceManagerErrorTags = new Set([
	"InstanceAlreadyExists",
	"InstanceLimitExceeded",
	"InstanceNotFound",
	"InvalidInstanceUrl",
]);

const isTaggedExpectedInstanceManagerError = (cause: unknown): boolean =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	typeof (cause as { _tag: unknown })._tag === "string" &&
	expectedInstanceManagerErrorTags.has((cause as { _tag: string })._tag);

const isExpectedLegacyInstanceManagerError = (cause: unknown): boolean => {
	if (cause instanceof OpenCodeConnectionError) return true;
	if (isTaggedInstanceLimitExceeded(cause)) return true;
	return isTaggedExpectedInstanceManagerError(cause);
};

const formatInstanceManagerCause = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

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
			Effect.try({
				try: () => {
					const config: InstanceConfig = {
						name: inst.name,
						port: inst.port,
						managed: inst.managed,
						...(inst.env != null && { env: inst.env }),
						...(inst.url != null && { url: inst.url }),
						...(inst.driver != null && { driver: inst.driver }),
						...(inst.configDir != null && { configDir: inst.configDir }),
					};
					mgmt.addInstance(inst.id, config);
				},
				catch: (cause) =>
					new InstanceRehydrationFailed({
						instanceId: inst.id,
						cause,
					}),
			}).pipe(
				Effect.catchTag("InstanceRehydrationFailed", (failure) => {
					if (!isExpectedLegacyInstanceManagerError(failure.cause)) {
						return Effect.die(failure.cause);
					}
					return Effect.logWarning(
						`Rehydration failed for instance ${failure.instanceId}: ${formatInstanceManagerCause(failure.cause)}`,
					);
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

/**
 * Orchestrator Effect that runs the full startup sequence.
 *
 * Steps (sequential):
 *   1. rehydrateInstances — restore persisted instances
 *   2. probeAndConvert — probe unmanaged instances
 *   3. detectSmartDefault — probe localhost:4096
 *
 * Expected errors are caught and logged by individual steps.
 */
export const runStartupSequence: Effect.Effect<
	void,
	never,
	DaemonStateTag | InstanceMgmtTag
> = Effect.gen(function* () {
	// Rehydrate instances
	yield* rehydrateInstances;

	// Probe and convert unmanaged instances
	yield* probeAndConvert;

	// Detect smart default
	yield* detectSmartDefault;

	yield* Effect.logInfo("Startup sequence complete");
}).pipe(
	Effect.annotateLogs("phase", "startup"),
	Effect.withSpan("runStartupSequence"),
);
