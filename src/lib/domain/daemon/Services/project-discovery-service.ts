import { resolve } from "node:path";
import { Effect, HashMap, Option, Ref } from "effect";
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

/**
 * Discover projects from the first available OpenCode instance.
 *
 * Returns the number of newly registered projects. Failures are logged and
 * treated as non-fatal so daemon startup can continue.
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

	const instances = yield* getInstances;
	const instanceList = Array.from(instances);
	if (instanceList.length === 0) {
		yield* Effect.logInfo("No instances available for project discovery");
		return 0;
	}

	const preferredInstance =
		instanceList.find((i) => i.status === "healthy") ?? instanceList[0];
	if (!preferredInstance) {
		yield* Effect.logInfo("No instances available for project discovery");
		return 0;
	}

	const opencodeUrl = yield* getInstanceUrl(preferredInstance.id);
	if (opencodeUrl === null) {
		yield* Effect.logInfo("Could not resolve URL for instance").pipe(
			Effect.annotateLogs("instanceId", preferredInstance.id),
		);
		return 0;
	}

	const config = yield* Ref.get(configRef);
	const dismissedPaths = config.dismissedPaths;

	const projects = yield* Effect.tryPromise({
		try: async () => {
			const { createSdkClient } = await import(
				"../../../instance/sdk-factory.js"
			);
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
		Effect.catchAll((e) =>
			Effect.logWarning("Failed to fetch projects from OpenCode").pipe(
				Effect.annotateLogs("error", String(e)),
				Effect.as(
					[] as Array<{ id?: string; worktree?: string; path?: string }>,
				),
			),
		),
	);

	let added = 0;
	for (const p of projects) {
		const dir = p.worktree ?? p.path;
		if (!dir || dir === "/") continue;

		const normalizedDir = resolve(dir);
		if (dismissedPaths.has(normalizedDir)) continue;

		const registryRef = yield* ProjectRegistryTag;
		const state = yield* Ref.get(registryRef);
		const existsByDir = Array.from(HashMap.values(state)).some(
			(e) => e.project.directory === normalizedDir,
		);
		if (existsByDir) continue;

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
		}).pipe(Effect.catchAll(() => Effect.void));
		added++;
	}

	const allSlugs = yield* slugs;
	for (const slug of allSlugs) {
		const entry = yield* getEntry(slug);
		if (Option.isNone(entry)) continue;
		if (entry.value._tag !== "Error") continue;

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
