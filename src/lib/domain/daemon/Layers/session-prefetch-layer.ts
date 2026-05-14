// ─── Session Prefetch Layer ─────────────────────────────────────────────────
// Scoped Layer that prefetches session counts for registered projects.
//
// Forks a scoped fiber that:
//   1. Iterates over all registered projects
//   2. Skips projects that already have persisted session counts
//   3. For each remaining project, fetches session count from OpenCode
//   4. Updates persistedSessionCounts in DaemonConfigRefTag
//
// Dependencies:
//   - DaemonConfigRefTag — for persistedSessionCounts, dismissed paths
//   - InstanceManagerStateTag — for resolving instance URLs and credentials
//   - ProjectRegistryTag — for iterating registered projects
//
// Error handling: all errors are caught per-project. Session count
// prefetch failure is non-fatal (the daemon shows 0 until the relay
// starts and gets real counts).
//
// (AP-33)

import { Effect, HashMap, Layer, Ref } from "effect";
import {
	commitDaemonRuntimeConfig,
	DaemonConfigRefTag,
} from "../Services/daemon-config-ref.js";
import {
	getInstance,
	getInstanceUrl,
	type InstanceManagerStateTag,
} from "../Services/instance-manager-service.js";
import { ProjectRegistryTag } from "../Services/project-registry-service.js";

// ─── prefetchSessionCounts ─────────────────────────────────────────────────

/**
 * Effect program that prefetches session counts for all registered projects
 * that don't already have persisted counts.
 *
 * For each project:
 * 1. Resolve the OpenCode URL from the project's instanceId
 * 2. Fetch the /session endpoint with credentials
 * 3. Update the persistedSessionCounts map in DaemonConfigRefTag
 *
 * Returns the number of projects for which counts were fetched.
 */
export const prefetchSessionCounts: Effect.Effect<
	number,
	never,
	DaemonConfigRefTag | InstanceManagerStateTag | ProjectRegistryTag
> = Effect.gen(function* () {
	const configRef = yield* DaemonConfigRefTag;
	const registryRef = yield* ProjectRegistryTag;

	const config = yield* Ref.get(configRef);
	const registryState = yield* Ref.get(registryRef);

	// Global credentials from environment
	const globalPassword = process.env["OPENCODE_SERVER_PASSWORD"] ?? "";
	const globalUsername = process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode";

	let fetched = 0;

	for (const [slug, entry] of HashMap.entries(registryState)) {
		// Skip if we already have persisted counts
		if (config.persistedSessionCounts.has(slug)) continue;

		// Resolve instance for this project
		const instanceId = entry.project.instanceId ?? "default";

		// Get the instance (may not exist — skip if not found)
		const instance = yield* getInstance(instanceId).pipe(
			Effect.catchTag("InstanceNotFound", () => Effect.succeed(null)),
		);
		if (instance === null) continue;

		// Resolve OpenCode URL via the instance manager
		const opencodeUrl = yield* getInstanceUrl(instanceId);
		if (opencodeUrl === null) continue;

		// Build auth headers
		const password =
			instance.env?.["OPENCODE_SERVER_PASSWORD"] ?? globalPassword;
		const username =
			instance.env?.["OPENCODE_SERVER_USERNAME"] ?? globalUsername;
		const headers: Record<string, string> = {
			"x-opencode-directory": entry.project.directory,
		};
		if (password) {
			headers["Authorization"] =
				`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
		}

		// Fetch session count (best-effort)
		const count = yield* Effect.tryPromise({
			try: async () => {
				const res = await fetch(`${opencodeUrl}/session?limit=10000`, {
					headers,
				});
				const data: unknown = await res.json();
				if (Array.isArray(data)) {
					return data.length;
				}
				return null;
			},
			catch: () => null,
		}).pipe(Effect.catchAll(() => Effect.succeed(null)));

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

// ─── SessionPrefetchLive ───────────────────────────────────────────────────

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
	DaemonConfigRefTag | InstanceManagerStateTag | ProjectRegistryTag
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
