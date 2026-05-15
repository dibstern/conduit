// ─── Project Discovery Layer ────────────────────────────────────────────────
// Scoped Layer that discovers projects from OpenCode on startup.
//
// Forks a scoped fiber that:
//   1. Resolves the OpenCode URL from InstanceManagerStateTag
//   2. Calls the OpenCode /project API to list known projects
//   3. For each discovered project directory:
//      a. Normalizes and resolves the path
//      b. Skips if directory is in dismissedPaths (from DaemonConfigRefTag)
//      c. Calls addWithoutRelay to register the project
//   4. Resets error-state projects for lazy retry
//
// Dependencies:
//   - DaemonConfigRefTag — for dismissedPaths
//   - InstanceManagerStateTag — for resolving OpenCode URL
//   - ProjectRegistryTag — for addWithoutRelay, getEntry, slugs
//
// Error handling: all errors are caught and logged. Discovery failure
// is non-fatal (the daemon continues without discovered projects).
//
// (AP-35)

import { Effect, Layer } from "effect";
import type { ConfigPersistenceTag } from "../Services/config-persistence-service.js";
import type { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import type { DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import type { InstanceManagerStateTag } from "../Services/instance-manager-service.js";
import { discoverProjectsEffect } from "../Services/project-discovery-service.js";
import type { ProjectRegistryTag } from "../Services/project-registry-service.js";

// ─── ProjectDiscoveryLive ──────────────────────────────────────────────────

/**
 * Scoped Layer that forks project discovery as a background fiber.
 *
 * The fiber runs once and exits (not a polling loop). It is tied to the
 * enclosing scope and will be interrupted on daemon shutdown.
 *
 * Error handling: all failures are caught and logged. Discovery failure
 * is non-fatal — the daemon continues with whatever projects were
 * already rehydrated from the saved config.
 */
export const ProjectDiscoveryLive: Layer.Layer<
	never,
	never,
	| DaemonConfigRefTag
	| DaemonEventBusTag
	| ConfigPersistenceTag
	| InstanceManagerStateTag
	| ProjectRegistryTag
> = Layer.scopedDiscard(
	Effect.gen(function* () {
		yield* Effect.logInfo("Project discovery layer initialized");

		// Fork discovery as a scoped fiber — interrupted on shutdown
		yield* Effect.forkScoped(discoverProjectsEffect);

		yield* Effect.addFinalizer(() =>
			Effect.logInfo("Project discovery layer torn down"),
		);
	}).pipe(
		Effect.annotateLogs("component", "project-discovery"),
		Effect.withSpan("ProjectDiscoveryLive"),
	),
);
