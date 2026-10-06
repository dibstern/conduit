// Scoped Layer that prefetches session counts for registered projects.
//
// Forks a scoped fiber that:
//   1. Iterates over all registered projects
//   2. Skips projects that already have persisted session counts
//   3. For each remaining project, fetches session count from OpenCode
//   4. Updates persistedSessionCounts in DaemonConfigRefTag
//
// Dependencies:
//   - DaemonConfigRefTag — for persistedSessionCounts
//   - OpenCodeInstancesTag — for a client when the instance is already running
//   - ProjectRegistryTag — for iterating registered projects
//
// Error handling: all errors are caught per-project. Session count
// prefetch failure is non-fatal (the daemon shows 0 until the relay
// starts and gets real counts).
//
// (AP-33)

import { existsSync } from "node:fs";
import { Effect, HashMap, Layer, Option, Ref } from "effect";
import {
	commitDaemonRuntimeConfig,
	DaemonConfigRefTag,
} from "../Services/daemon-config-ref.js";
import { OpenCodeInstancesTag } from "../Services/opencode-instances-service.js";
import { ProjectRegistryTag } from "../Services/project-registry-service.js";

/**
 * Effect program that prefetches session counts for all registered projects
 * that don't already have persisted counts.
 *
 * For each project:
 * 1. Take a client for the project's instance only if it is already running
 * 2. List the project's sessions
 * 3. Update the persistedSessionCounts map in DaemonConfigRefTag
 *
 * Returns the number of projects for which counts were fetched.
 */
export const prefetchSessionCounts: Effect.Effect<
	number,
	never,
	DaemonConfigRefTag | OpenCodeInstancesTag | ProjectRegistryTag
> = Effect.gen(function* () {
	const configRef = yield* DaemonConfigRefTag;
	const registryRef = yield* ProjectRegistryTag;
	const instances = yield* OpenCodeInstancesTag;

	const config = yield* Ref.get(configRef);
	const registryState = yield* Ref.get(registryRef);

	let fetched = 0;

	for (const [slug, entry] of HashMap.entries(registryState)) {
		if (!existsSync(entry.project.folders[0])) continue;
		// Skip if we already have persisted counts
		if (config.persistedSessionCounts.has(slug)) continue;

		// Best-effort count, only from an instance that is already running.
		const count = yield* instances
			.ifRunning(
				entry.project.instanceId ?? "default",
				entry.project.folders[0],
			)
			.pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeed(null),
						onSome: (client) =>
							Effect.tryPromise(() =>
								client.session.list({ limit: 10000 }),
							).pipe(Effect.map((sessions) => sessions.length)),
					}),
				),
				Effect.scoped,
				Effect.catchAll(() => Effect.succeed(null)),
			);

		if (count !== null && count > 0) {
			yield* commitDaemonRuntimeConfig((c) => ({
				...c,
				persistedSessionCounts: new Map([
					...c.persistedSessionCounts,
					[slug, count],
				]),
			}));
			fetched++;
		}
	}

	if (fetched > 0) {
		yield* Effect.logInfo(
			`Prefetched session counts for ${fetched} project(s)`,
		);
	}

	return fetched;
}).pipe(
	Effect.catchAll((e) =>
		Effect.logWarning("Session prefetch failed").pipe(
			Effect.annotateLogs("error", String(e)),
			Effect.as(0),
		),
	),
	Effect.annotateLogs("task", "sessionPrefetch"),
	Effect.withSpan("prefetchSessionCounts"),
);

/**
 * Scoped Layer that forks session count prefetching as a background fiber.
 *
 * The fiber runs once and exits (not a polling loop). It is tied to the
 * enclosing scope and will be interrupted on daemon shutdown.
 *
 * Error handling: all failures are caught per-project and logged.
 * Prefetch failure is non-fatal — session counts default to 0 until
 * the relay starts and reports real counts.
 */
export const SessionPrefetchLive: Layer.Layer<
	never,
	never,
	DaemonConfigRefTag | OpenCodeInstancesTag | ProjectRegistryTag
> = Layer.scopedDiscard(
	Effect.gen(function* () {
		yield* Effect.logInfo("Session prefetch layer initialized");

		// Fork prefetch as a scoped fiber — interrupted on shutdown
		yield* Effect.forkScoped(prefetchSessionCounts);

		yield* Effect.addFinalizer(() =>
			Effect.logInfo("Session prefetch layer torn down"),
		);
	}).pipe(
		Effect.annotateLogs("component", "session-prefetch"),
		Effect.withSpan("SessionPrefetchLive"),
	),
);
