// ─── ProjectRegistry Service (Effect) ────────────────────────────────────────
// Dissolves the imperative ProjectRegistry class into Effect-native primitives:
//   - Ref<HashMap<string, ProjectState>> for project entries
//   - PubSub publish via DaemonEventBusTag for lifecycle events
//   - Pure Effect functions for add/remove/get/list/update
//
// The old class used typed callback maps (not EventEmitter) and AbortController
// for relay cancellation. This service replaces callbacks with DaemonEventBus
// publishes, and AbortController with Effect Scope/interruption.
//
// Relay lifecycle is delegated to RelayCacheTag (Task 18).

import {
	Context,
	Data,
	Duration,
	Effect,
	HashMap,
	Layer,
	Option,
	PubSub,
	Ref,
	Stream,
} from "effect";

import type { StoredProject } from "../types.js";
import { DaemonEvent, DaemonEventBusTag } from "./daemon-pubsub.js";
import { RelayCacheTag } from "./relay-cache.js";

const PROJECT_REMOVE_ALL_CONCURRENCY = 4;

// ─── Project state discriminated union ───────────────────────────────────────

export interface ProjectRegistering {
	readonly _tag: "Registering";
	readonly project: StoredProject;
}

export interface ProjectReady {
	readonly _tag: "Ready";
	readonly project: StoredProject;
}

export interface ProjectError {
	readonly _tag: "Error";
	readonly project: StoredProject;
	readonly error: string;
}

export type ProjectState = ProjectRegistering | ProjectReady | ProjectError;

// ─── Error types ─────────────────────────────────────────────────────────────

export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{
	slug: string;
}> {}

export class ProjectAlreadyExists extends Data.TaggedError(
	"ProjectAlreadyExists",
)<{
	slug: string;
}> {}

export class ProjectAlreadyReady extends Data.TaggedError(
	"ProjectAlreadyReady",
)<{
	slug: string;
}> {}

// ─── State type ──────────────────────────────────────────────────────────────

export type ProjectRegistryState = HashMap.HashMap<string, ProjectState>;

// ─── Context Tag ─────────────────────────────────────────────────────────────

export class ProjectRegistryTag extends Context.Tag("ProjectRegistry")<
	ProjectRegistryTag,
	Ref.Ref<ProjectRegistryState>
>() {}

// ─── Pure query functions ────────────────────────────────────────────────────

/** Get a project entry by slug. Returns Option. */
export const getEntry = (slug: string) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const state = yield* Ref.get(ref);
		return HashMap.get(state, slug);
	}).pipe(
		Effect.annotateLogs("slug", slug),
		Effect.withSpan("projectRegistry.getEntry"),
	);

/** Get the StoredProject for a slug, or fail with ProjectNotFound. */
export const getProject = (slug: string) =>
	Effect.gen(function* () {
		const entry = yield* getEntry(slug);
		if (Option.isNone(entry)) {
			return yield* new ProjectNotFound({ slug });
		}
		return entry.value.project;
	}).pipe(
		Effect.annotateLogs("slug", slug),
		Effect.withSpan("projectRegistry.getProject"),
	);

/** Check if a slug is registered. */
export const has = (slug: string) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const state = yield* Ref.get(ref);
		return HashMap.has(state, slug);
	}).pipe(Effect.withSpan("projectRegistry.has"));

/** Check if a slug is in Ready state. */
export const isReady = (slug: string) =>
	Effect.gen(function* () {
		const entry = yield* getEntry(slug);
		return Option.isSome(entry) && entry.value._tag === "Ready";
	}).pipe(Effect.withSpan("projectRegistry.isReady"));

/** Find a project entry by directory path. Returns Option. */
export const findByDirectory = (directory: string) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const state = yield* Ref.get(ref);
		const entries = HashMap.values(state);
		for (const entry of entries) {
			if (entry.project.directory === directory) {
				return Option.some(entry);
			}
		}
		return Option.none<ProjectState>();
	}).pipe(Effect.withSpan("projectRegistry.findByDirectory"));

/** Get all projects sorted by lastUsed descending. */
export const allProjects = Effect.gen(function* () {
	const ref = yield* ProjectRegistryTag;
	const state = yield* Ref.get(ref);
	const projects: StoredProject[] = [];
	for (const entry of HashMap.values(state)) {
		projects.push(entry.project);
	}
	return projects.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
}).pipe(Effect.withSpan("projectRegistry.allProjects"));

/** Get all ready entries as [slug, ProjectReady] pairs. */
export const readyEntries = Effect.gen(function* () {
	const ref = yield* ProjectRegistryTag;
	const state = yield* Ref.get(ref);
	const result: Array<[string, ProjectReady]> = [];
	for (const [slug, entry] of HashMap.entries(state)) {
		if (entry._tag === "Ready") {
			result.push([slug, entry]);
		}
	}
	return result;
}).pipe(Effect.withSpan("projectRegistry.readyEntries"));

/** Get all registered slugs. */
export const slugs = Effect.gen(function* () {
	const ref = yield* ProjectRegistryTag;
	const state = yield* Ref.get(ref);
	return Array.from(HashMap.keys(state));
}).pipe(Effect.withSpan("projectRegistry.slugs"));

/** Get the number of registered projects. */
export const size = Effect.gen(function* () {
	const ref = yield* ProjectRegistryTag;
	const state = yield* Ref.get(ref);
	return HashMap.size(state);
}).pipe(Effect.withSpan("projectRegistry.size"));

// ─── Mutation functions ──────────────────────────────────────────────────────

/**
 * Register a project without starting a relay. Sets status to Registering.
 * Publishes InstanceAdded event unless silent is true.
 */
export const addWithoutRelay = (
	project: StoredProject,
	options?: { silent?: boolean },
) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const bus = yield* DaemonEventBusTag;

		// Atomic check-and-set via Ref.modify
		const alreadyExists = yield* Ref.modify(ref, (state) => {
			if (HashMap.has(state, project.slug)) {
				return [true, state] as const;
			}
			const entry: ProjectRegistering = {
				_tag: "Registering",
				project,
			};
			return [false, HashMap.set(state, project.slug, entry)] as const;
		});

		if (alreadyExists) {
			return yield* new ProjectAlreadyExists({ slug: project.slug });
		}

		if (!options?.silent) {
			yield* PubSub.publish(
				bus,
				DaemonEvent.InstanceAdded({ instanceId: project.slug }),
			);
		}

		yield* Effect.logInfo("Project registered");
	}).pipe(
		Effect.annotateLogs("slug", project.slug),
		Effect.withSpan("projectRegistry.addWithoutRelay", {
			attributes: { slug: project.slug },
		}),
	);

/**
 * Transition a project to Ready state. Publishes InstanceStatusChanged.
 * Fails with ProjectNotFound if not registered.
 */
export const markReady = (slug: string) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const bus = yield* DaemonEventBusTag;

		const notFound = yield* Ref.modify(ref, (state) => {
			const existing = HashMap.get(state, slug);
			if (Option.isNone(existing)) {
				return [true, state] as const;
			}
			const entry: ProjectReady = {
				_tag: "Ready",
				project: existing.value.project,
			};
			return [false, HashMap.set(state, slug, entry)] as const;
		});

		if (notFound) {
			return yield* new ProjectNotFound({ slug });
		}

		yield* PubSub.publish(
			bus,
			DaemonEvent.InstanceStatusChanged({ instanceId: slug }),
		);

		yield* Effect.logInfo("Project relay ready");
	}).pipe(
		Effect.annotateLogs("slug", slug),
		Effect.withSpan("projectRegistry.markReady", {
			attributes: { slug },
		}),
	);

/**
 * Transition a project to Error state. Publishes InstanceStatusChanged.
 * Fails with ProjectNotFound if not registered.
 */
export const markError = (slug: string, error: string) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const bus = yield* DaemonEventBusTag;

		const notFound = yield* Ref.modify(ref, (state) => {
			const existing = HashMap.get(state, slug);
			if (Option.isNone(existing)) {
				return [true, state] as const;
			}
			const entry: ProjectError = {
				_tag: "Error",
				project: existing.value.project,
				error,
			};
			return [false, HashMap.set(state, slug, entry)] as const;
		});

		if (notFound) {
			return yield* new ProjectNotFound({ slug });
		}

		yield* PubSub.publish(
			bus,
			DaemonEvent.InstanceStatusChanged({ instanceId: slug }),
		);

		yield* Effect.logWarning("Project relay failed", { error });
	}).pipe(
		Effect.annotateLogs("slug", slug),
		Effect.withSpan("projectRegistry.markError", {
			attributes: { slug },
		}),
	);

/**
 * Remove a project. Invalidates its relay via RelayCacheTag.
 * Publishes InstanceRemoved event. No-op if slug not registered.
 */
export const remove = (slug: string) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const bus = yield* DaemonEventBusTag;
		const relayCache = yield* RelayCacheTag;

		const existed = yield* Ref.modify(ref, (state) => {
			if (!HashMap.has(state, slug)) {
				return [false, state] as const;
			}
			return [true, HashMap.remove(state, slug)] as const;
		});

		if (!existed) return;

		// Invalidate relay (stops it via ScopedRef finalizer)
		yield* relayCache.invalidate(slug);

		yield* PubSub.publish(
			bus,
			DaemonEvent.InstanceRemoved({ instanceId: slug }),
		);

		yield* Effect.logInfo("Project removed");
	}).pipe(
		Effect.annotateLogs("slug", slug),
		Effect.withSpan("projectRegistry.remove", {
			attributes: { slug },
		}),
	);

/**
 * Update project fields (title, instanceId). Publishes InstanceStatusChanged.
 * Fails with ProjectNotFound if slug not registered.
 */
export const updateProject = (
	slug: string,
	updates: Partial<Pick<StoredProject, "title" | "instanceId">>,
) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const bus = yield* DaemonEventBusTag;

		const notFound = yield* Ref.modify(ref, (state) => {
			const existing = HashMap.get(state, slug);
			if (Option.isNone(existing)) {
				return [true, state] as const;
			}
			const entry = existing.value;
			const updatedProject = { ...entry.project, ...updates };
			const updatedEntry: ProjectState =
				entry._tag === "Ready"
					? { ...entry, project: updatedProject }
					: entry._tag === "Error"
						? { ...entry, project: updatedProject }
						: { ...entry, project: updatedProject };
			return [false, HashMap.set(state, slug, updatedEntry)] as const;
		});

		if (notFound) {
			return yield* new ProjectNotFound({ slug });
		}

		yield* PubSub.publish(
			bus,
			DaemonEvent.InstanceStatusChanged({ instanceId: slug }),
		);
	}).pipe(
		Effect.annotateLogs("slug", slug),
		Effect.withSpan("projectRegistry.updateProject", {
			attributes: { slug },
		}),
	);

/**
 * Bump lastUsed timestamp for a project (e.g. on WS connect).
 * Publishes InstanceStatusChanged. No-op if slug not found.
 */
export const touchLastUsed = (slug: string) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const bus = yield* DaemonEventBusTag;

		const existed = yield* Ref.modify(ref, (state) => {
			const existing = HashMap.get(state, slug);
			if (Option.isNone(existing)) {
				return [false, state] as const;
			}
			const entry = existing.value;
			const updatedProject = { ...entry.project, lastUsed: Date.now() };
			const updatedEntry: ProjectState =
				entry._tag === "Ready"
					? { ...entry, project: updatedProject }
					: entry._tag === "Error"
						? { ...entry, project: updatedProject }
						: { ...entry, project: updatedProject };
			return [true, HashMap.set(state, slug, updatedEntry)] as const;
		});

		if (existed) {
			yield* PubSub.publish(
				bus,
				DaemonEvent.InstanceStatusChanged({ instanceId: slug }),
			);
		}
	}).pipe(
		Effect.annotateLogs("slug", slug),
		Effect.withSpan("projectRegistry.touchLastUsed"),
	);

/**
 * Start a relay for a slug via RelayCacheTag.get(). Transitions
 * from Registering/Error → Ready on success, or → Error on failure.
 * Publishes appropriate InstanceStatusChanged events.
 */
export const startRelay = (slug: string) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const relayCache = yield* RelayCacheTag;

		// Verify the entry exists and is not already ready
		const state = yield* Ref.get(ref);
		const existing = HashMap.get(state, slug);
		if (Option.isNone(existing)) {
			return yield* new ProjectNotFound({ slug });
		}
		if (existing.value._tag === "Ready") {
			return yield* new ProjectAlreadyReady({ slug });
		}

		// Reset to Registering
		yield* Ref.update(ref, (s) =>
			HashMap.set(s, slug, {
				_tag: "Registering" as const,
				project: existing.value.project,
			}),
		);

		// Delegate relay creation to RelayCacheTag.
		// RelayCache.get has `never` error channel — failures surface as defects.
		yield* relayCache.get(slug).pipe(
			Effect.flatMap(() => markReady(slug)),
			Effect.catchAllDefect((defect) =>
				markError(
					slug,
					defect instanceof Error ? defect.message : String(defect),
				),
			),
		);
	}).pipe(
		Effect.annotateLogs("slug", slug),
		Effect.withSpan("projectRegistry.startRelay", {
			attributes: { slug },
		}),
	);

/**
 * Remove all projects and invalidate all relays.
 * Publishes InstanceRemoved for each removed project.
 */
export const removeAll = Effect.gen(function* () {
	const ref = yield* ProjectRegistryTag;
	const bus = yield* DaemonEventBusTag;
	const relayCache = yield* RelayCacheTag;

	const state = yield* Ref.get(ref);
	const allSlugs = Array.from(HashMap.keys(state));

	// Clear all entries atomically
	yield* Ref.set(ref, HashMap.empty());

	// Invalidate all relays and publish removal events
	yield* Effect.forEach(
		allSlugs,
		(slug) =>
			Effect.gen(function* () {
				yield* relayCache.invalidate(slug);
				yield* PubSub.publish(
					bus,
					DaemonEvent.InstanceRemoved({ instanceId: slug }),
				);
			}),
		{ concurrency: PROJECT_REMOVE_ALL_CONCURRENCY, discard: true },
	);

	yield* Effect.logInfo(`Removed ${allSlugs.length} project(s)`);
}).pipe(Effect.withSpan("projectRegistry.removeAll"));

// ─── Additional operations (Task 6 gap-fill) ───────────────────────────────

/**
 * Broadcast a message to all connected clients via DaemonEventBus.
 * Publishes a RelayBroadcast event that consumers (e.g., WS handlers)
 * can subscribe to for cross-relay broadcasting.
 */
export const broadcastToAll = (message: unknown) =>
	Effect.gen(function* () {
		const bus = yield* DaemonEventBusTag;
		yield* PubSub.publish(bus, DaemonEvent.RelayBroadcast({ message }));
	}).pipe(Effect.withSpan("projectRegistry.broadcastToAll"));

/**
 * Wait until a project transitions to Ready state, or timeout.
 * Subscribes to DaemonEventBus and filters for InstanceStatusChanged
 * events matching the given slug.
 */
export const waitForRelay = (slug: string, timeoutMs: number) =>
	Effect.gen(function* () {
		// Check if already ready
		const entry = yield* getEntry(slug);
		if (Option.isNone(entry)) {
			return yield* new ProjectNotFound({ slug });
		}
		if (entry.value._tag === "Ready") {
			return; // Already ready
		}

		// Subscribe to events and wait for InstanceStatusChanged with this slug
		const bus = yield* DaemonEventBusTag;
		const sub = yield* PubSub.subscribe(bus);
		yield* Stream.fromQueue(sub).pipe(
			Stream.filter(
				(e) => e._tag === "InstanceStatusChanged" && e.instanceId === slug,
			),
			Stream.take(1),
			Stream.runDrain,
		);

		// Verify it's actually ready (could be error transition)
		const final = yield* getEntry(slug);
		if (Option.isNone(final) || final.value._tag !== "Ready") {
			return yield* new ProjectNotFound({ slug });
		}
	}).pipe(
		Effect.timeout(Duration.millis(timeoutMs)),
		Effect.annotateLogs("slug", slug),
		Effect.withSpan("projectRegistry.waitForRelay"),
	);

/**
 * Evict oldest sessions across relays. Stub implementation until
 * relay access is available in later phases.
 */
export const evictOldestSessions = (count: number) =>
	Effect.gen(function* () {
		// TODO: Implement session eviction after relay access is available
		yield* Effect.logInfo(`Eviction requested for ${count} sessions (stub)`);
		return [] as string[];
	}).pipe(Effect.withSpan("projectRegistry.evictOldestSessions"));

/**
 * Replace the relay for a slug. Invalidates the old relay via RelayCacheTag,
 * creates a new one, and transitions the project to Ready.
 */
export const replaceRelay = (slug: string) =>
	Effect.gen(function* () {
		const relayCache = yield* RelayCacheTag;
		yield* relayCache.invalidate(slug);
		yield* relayCache.get(slug);
		yield* markReady(slug);
	}).pipe(
		Effect.annotateLogs("slug", slug),
		Effect.withSpan("projectRegistry.replaceRelay"),
	);

/**
 * Check if a project is currently in Registering state
 * (i.e., a relay creation is in-flight).
 */
export const isStarting = (slug: string) =>
	getEntry(slug).pipe(
		Effect.map(Option.map((e) => e._tag === "Registering")),
		Effect.map(Option.getOrElse(() => false)),
	);

// ─── Layer factory ───────────────────────────────────────────────────────────

/**
 * Create a Layer providing ProjectRegistryTag backed by a Ref<HashMap>.
 * Uses Layer.effect (not scoped) since the Ref itself has no finalizer.
 */
export const makeProjectRegistryLive = (): Layer.Layer<ProjectRegistryTag> =>
	Layer.effect(
		ProjectRegistryTag,
		Ref.make<ProjectRegistryState>(HashMap.empty()),
	);
