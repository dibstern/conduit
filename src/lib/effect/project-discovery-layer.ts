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

import { resolve } from "node:path";
import { Effect, HashMap, Layer, Option, Ref } from "effect";
import type { ConfigPersistenceTag } from "./config-persistence-service.js";
import { DaemonConfigRefTag } from "./daemon-config-ref.js";
import type { DaemonEventBusTag } from "./daemon-pubsub.js";
import {
	getInstances,
	getInstanceUrl,
	type InstanceManagerStateTag,
} from "./instance-manager-service.js";
import {
	addWithoutRelay,
	getEntry,
	ProjectRegistryTag,
	slugs,
} from "./project-registry-service.js";

// ─── discoverProjectsEffect ────────────────────────────────────────────────

/**
 * Effect program that discovers projects from the first healthy OpenCode
 * instance. Can be called directly or forked as a scoped fiber.
 *
 * Returns the number of newly added projects (for testing/logging).
 */
export const discoverProjectsEffect: Effect.Effect<
	number,
	never,
	| DaemonConfigRefTag
	| DaemonEventBusTag
	| ConfigPersistenceTag
	| InstanceManagerStateTag
	| ProjectRegistryTag
> = Effect.gen(function* () {
	const configRef = yield* DaemonConfigRefTag;

	// Resolve OpenCode URL from the first available instance
	const instances = yield* getInstances;
	const instanceList = Array.from(instances);
	if (instanceList.length === 0) {
		yield* Effect.logInfo("No instances available for project discovery");
		return 0;
	}

	// Pick the first instance (prefer healthy, but take any)
	const preferredInstance =
		instanceList.find((i) => i.status === "healthy") ?? instanceList[0];
	if (!preferredInstance) {
		yield* Effect.logInfo("No instances available for project discovery");
		return 0;
	}

	// Resolve the OpenCode URL for this instance
	const opencodeUrl = yield* getInstanceUrl(preferredInstance.id);
	if (opencodeUrl === null) {
		yield* Effect.logInfo("Could not resolve URL for instance").pipe(
			Effect.annotateLogs("instanceId", preferredInstance.id),
		);
		return 0;
	}

	// Read dismissed paths from DaemonConfigRef
	const config = yield* Ref.get(configRef);
	const dismissedPaths = config.dismissedPaths;

	// Call OpenCode project list API
	const projects = yield* Effect.tryPromise({
		try: async () => {
			const { createSdkClient } = await import("../instance/sdk-factory.js");
			const { client } = createSdkClient({ baseUrl: opencodeUrl });
			const result = await client.project.list();
			return (
				(
					result as {
						data?: Array<{
							id?: string;
							worktree?: string;
							path?: string;
						}>;
					}
				).data ?? []
			);
		},
		catch: (cause) => cause,
	}).pipe(
		Effect.catchAll((e) => {
			return Effect.logWarning("Failed to fetch projects from OpenCode").pipe(
				Effect.annotateLogs("error", String(e)),
				Effect.as(
					[] as Array<{ id?: string; worktree?: string; path?: string }>,
				),
			);
		}),
	);

	// Register each discovered project
	let added = 0;
	for (const p of projects) {
		const dir = p.worktree ?? p.path;
		if (!dir || dir === "/") continue;

		const normalizedDir = resolve(dir);
		if (dismissedPaths.has(normalizedDir)) continue;

		// Check if already registered by looking at the registry directly
		const registryRef = yield* ProjectRegistryTag;
		const state = yield* Ref.get(registryRef);
		const existsByDir = Array.from(HashMap.values(state)).some(
			(e) => e.project.directory === normalizedDir,
		);
		if (existsByDir) continue;

		// Generate a slug from the directory name
		const parts = normalizedDir.replace(/\\/g, "/").split("/").filter(Boolean);
		const title = parts[parts.length - 1] ?? "project";
		const existingSlugs = new Set(Array.from(HashMap.keys(state)));
		let baseSlug = title.toLowerCase().replace(/[^a-z0-9-]/g, "-");
		if (!baseSlug || baseSlug === "-") baseSlug = "project";
		let slug = baseSlug;
		let counter = 1;
		while (existingSlugs.has(slug)) {
			slug = `${baseSlug}-${counter}`;
			counter++;
		}

		yield* addWithoutRelay({
			slug,
			directory: normalizedDir,
			title,
			lastUsed: Date.now(),
			...(preferredInstance.id != null && {
				instanceId: preferredInstance.id,
			}),
		}).pipe(
			Effect.catchAll(() => Effect.void), // Non-fatal: skip duplicates
		);
		added++;
	}

	// Reset error-state projects for lazy retry
	const allSlugs = yield* slugs;
	for (const slug of allSlugs) {
		const entry = yield* getEntry(slug);
		if (Option.isNone(entry)) continue;
		if (entry.value._tag !== "Error") continue;

		// Re-register as Registering for lazy retry
		yield* addWithoutRelay(entry.value.project, { silent: true }).pipe(
			Effect.catchAll(() => Effect.void),
		);
		yield* Effect.logInfo("Reset error-state project for lazy retry").pipe(
			Effect.annotateLogs("slug", slug),
		);
	}

	yield* Effect.logInfo(
		`Discovered ${projects.length} project(s) from OpenCode, registered ${added}`,
	);
	return added;
}).pipe(
	Effect.catchAll((e) =>
		Effect.logWarning("Project discovery failed").pipe(
			Effect.annotateLogs("error", String(e)),
			Effect.as(0),
		),
	),
	Effect.annotateLogs("task", "projectDiscovery"),
	Effect.withSpan("discoverProjectsEffect"),
);

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
