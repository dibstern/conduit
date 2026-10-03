// ProjectRegistry Service (Effect)
// Dissolves the imperative ProjectRegistry class into Effect-native primitives:
//   - Ref<HashMap<string, ProjectState>> for project entries
//   - PubSub publish via DaemonEventBusTag for lifecycle events
//   - Pure Effect functions for add/remove/get/list/update
//
// The old class used typed callback maps (not EventEmitter) and AbortController
// for relay cancellation. This service replaces callbacks with DaemonEventBus
// publishes, and AbortController with Effect Scope/interruption.
//
// Relay lifecycle is delegated to RelayCacheTag.

import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
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
import {
	ProjectSaveRejected,
	type SaveProjectInput,
	WsRpcError,
} from "../../../contracts/ws-rpc.js";
import { withCachedProjectGit } from "../../../git/session-git.js";
import { normalizeProjectTitle } from "../../../handlers/settings.js";
import {
	chooseProjectSlug,
	projectEventsDbPath,
	projectStorageDir,
} from "../../../persistence/project-storage.js";
import { checkFolders, type FolderIssue } from "../../../project-folders.js";
import { stopRegisteredClaudeRunners } from "../../../provider/claude/claude-process-session-runner.js";
import type { StoredProject } from "../../../types.js";
import { requestConfigSave } from "./config-persistence-service.js";
import { DaemonEvent, DaemonEventBusTag } from "./daemon-pubsub.js";
import { countRunningProjectSessions } from "./daemon-session-reader.js";
import { type DaemonProject, DaemonStateTag } from "./daemon-state.js";
import { RelayCacheTag } from "./relay-cache.js";

const PROJECT_REMOVE_ALL_CONCURRENCY = 4;

const formatRelayFailure = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

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

export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{
	slug: string;
}> {
	get message(): string {
		return `Project "${this.slug}" not found`;
	}
}

export class ProjectAlreadyExists extends Data.TaggedError(
	"ProjectAlreadyExists",
)<{
	slug: string;
}> {
	get message(): string {
		return `Project already exists: ${this.slug}`;
	}
}

export class ProjectAlreadyReady extends Data.TaggedError(
	"ProjectAlreadyReady",
)<{
	slug: string;
}> {
	get message(): string {
		return `Project "${this.slug}" is already ready`;
	}
}

export type ProjectRegistryState = HashMap.HashMap<string, ProjectState>;

const toStoredProject = (project: DaemonProject): StoredProject => ({
	slug: project.slug,
	directory: project.folders?.[0] ?? project.directory ?? project.path,
	folders: project.folders ?? [project.directory ?? project.path],
	title: project.title ?? project.slug,
	lastUsed: project.addedAt,
	...(project.instanceId !== undefined && { instanceId: project.instanceId }),
	...(project.shellEnv !== undefined && { shellEnv: project.shellEnv }),
});

const makeInitialProjectState = (
	projects: ReadonlyArray<StoredProject>,
): ProjectRegistryState =>
	HashMap.fromIterable(
		projects.map(
			(project) =>
				[
					project.slug,
					{
						_tag: "Registering",
						project,
					} satisfies ProjectRegistering,
				] as const,
		),
	);

export class ProjectRegistryTag extends Context.Tag("ProjectRegistry")<
	ProjectRegistryTag,
	Ref.Ref<ProjectRegistryState>
>() {}

export class ProjectSaveLockTag extends Context.Tag("ProjectSaveLock")<
	ProjectSaveLockTag,
	Effect.Semaphore
>() {}

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

export const projectInfos = allProjects.pipe(
	Effect.map((projects) =>
		withCachedProjectGit(
			projects.map((project) => ({
				slug: project.slug,
				directory: project.directory,
				folders: project.folders,
				title: project.title,
				...(project.lastUsed !== undefined && { lastUsed: project.lastUsed }),
				...(project.instanceId !== undefined && {
					instanceId: project.instanceId,
				}),
			})),
		),
	),
);

export const broadcastProjectList = Effect.gen(function* () {
	const projects = yield* projectInfos;
	yield* broadcastToAll({ type: "project_list", projects });
	return projects;
});

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

		yield* requestConfigSave;
		yield* Effect.logInfo("Project registered");
	}).pipe(
		Effect.annotateLogs("slug", project.slug),
		Effect.withSpan("projectRegistry.addWithoutRelay", {
			attributes: { slug: project.slug },
		}),
	);

/**
 * Transition a project to Ready state. Publishes InstanceStatusChanged only on transition.
 * Fails with ProjectNotFound if not registered.
 */
export const markReady = (slug: string) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const bus = yield* DaemonEventBusTag;

		const result = yield* Ref.modify(ref, (state) => {
			const existing = HashMap.get(state, slug);
			if (Option.isNone(existing)) {
				return ["NotFound", state] as const;
			}
			if (existing.value._tag === "Ready") {
				return ["AlreadyReady", state] as const;
			}
			const entry: ProjectReady = {
				_tag: "Ready",
				project: existing.value.project,
			};
			return ["Ready", HashMap.set(state, slug, entry)] as const;
		});

		if (result === "NotFound") {
			return yield* new ProjectNotFound({ slug });
		}
		if (result === "AlreadyReady") {
			return;
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
	Effect.flatMap(ProjectSaveLockTag, (lock) =>
		lock.withPermits(1)(
			Effect.gen(function* () {
				const ref = yield* ProjectRegistryTag;
				const bus = yield* DaemonEventBusTag;
				const relayCache = yield* RelayCacheTag;

				const removed = yield* Ref.modify(ref, (state) => {
					const entry = HashMap.get(state, slug);
					return [
						entry,
						Option.isSome(entry) ? HashMap.remove(state, slug) : state,
					] as const;
				});

				if (Option.isNone(removed)) return;

				yield* Effect.gen(function* () {
					// Relay disposal only detaches; removal ends every registered runner afterwards.
					yield* relayCache.invalidate(slug);
					const state = yield* Ref.get(yield* DaemonStateTag);
					yield* stopRegisteredClaudeRunners(
						removed.value.project.directory,
						state.configDir,
					);
				}).pipe(
					Effect.onError(() =>
						// Failed removal must remain reachable by retries and a full stop.
						Ref.update(ref, (state) =>
							HashMap.has(state, slug)
								? state
								: HashMap.set(state, slug, {
										_tag: "Registering",
										project: removed.value.project,
									}),
						).pipe(Effect.andThen(requestConfigSave)),
					),
				);

				yield* PubSub.publish(
					bus,
					DaemonEvent.InstanceRemoved({ instanceId: slug }),
				);

				yield* requestConfigSave;
				yield* Effect.logInfo("Project removed");
			}),
		),
	).pipe(
		Effect.uninterruptible,
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
	updates: Partial<
		Pick<StoredProject, "title" | "instanceId" | "directory" | "folders">
	>,
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
			const updatedEntry: ProjectState = { ...entry, project: updatedProject };
			return [false, HashMap.set(state, slug, updatedEntry)] as const;
		});

		if (notFound) {
			return yield* new ProjectNotFound({ slug });
		}

		yield* PubSub.publish(
			bus,
			DaemonEvent.InstanceStatusChanged({ instanceId: slug }),
		);
		yield* requestConfigSave;
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
			const updatedEntry: ProjectState = { ...entry, project: updatedProject };
			return [true, HashMap.set(state, slug, updatedEntry)] as const;
		});

		if (existed) {
			yield* PubSub.publish(
				bus,
				DaemonEvent.InstanceStatusChanged({ instanceId: slug }),
			);
			yield* requestConfigSave;
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

		// Delegate relay creation to RelayCacheTag and keep the registry state
		// honest for both typed startup failures and defects.
		yield* relayCache.get(slug).pipe(
			Effect.flatMap(() => markReady(slug)),
			Effect.catchAll((cause) => markError(slug, formatRelayFailure(cause))),
			Effect.catchAllDefect((defect) =>
				markError(slug, formatRelayFailure(defect)),
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

	yield* requestConfigSave;
	yield* Effect.logInfo(`Removed ${allSlugs.length} project(s)`);
}).pipe(Effect.withSpan("projectRegistry.removeAll"));

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
		// Subscribe before checking: markReady publishes only on a real
		// transition, so one landing between check and subscribe would be lost.
		const bus = yield* DaemonEventBusTag;
		const sub = yield* PubSub.subscribe(bus);

		const entry = yield* getEntry(slug);
		if (Option.isNone(entry)) {
			return yield* new ProjectNotFound({ slug });
		}
		if (entry.value._tag === "Ready") {
			return;
		}

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
		yield* relayCache.get(slug).pipe(
			Effect.flatMap(() => markReady(slug)),
			Effect.catchAll((cause) => markError(slug, formatRelayFailure(cause))),
			Effect.catchAllDefect((defect) =>
				markError(slug, formatRelayFailure(defect)),
			),
		);
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

/**
 * Create a Layer providing ProjectRegistryTag backed by a Ref<HashMap>.
 * Uses Layer.effect (not scoped) since the Ref itself has no finalizer.
 */
export const makeProjectRegistryLive = (
	initialProjects: ReadonlyArray<StoredProject> = [],
): Layer.Layer<ProjectRegistryTag | ProjectSaveLockTag> =>
	Layer.effectContext(
		Effect.gen(function* () {
			const ref = yield* Ref.make<ProjectRegistryState>(
				makeInitialProjectState(initialProjects),
			);
			const lock = yield* Effect.makeSemaphore(1);
			return Context.make(ProjectRegistryTag, ref).pipe(
				Context.add(ProjectSaveLockTag, lock),
			);
		}),
	);

export const makeProjectRegistryFromDaemonStateLive: Layer.Layer<
	ProjectRegistryTag | ProjectSaveLockTag,
	never,
	DaemonStateTag
> = Layer.effectContext(
	Effect.gen(function* () {
		const stateRef = yield* DaemonStateTag;
		const state = yield* Ref.get(stateRef);
		const initialProjects = state.projects.map(toStoredProject);
		const ref = yield* Ref.make<ProjectRegistryState>(
			makeInitialProjectState(initialProjects),
		);
		const lock = yield* Effect.makeSemaphore(1);
		return Context.make(ProjectRegistryTag, ref).pipe(
			Context.add(ProjectSaveLockTag, lock),
		);
	}),
);

export const normalizeProjectDirectory = (directory: string): string => {
	const expanded =
		directory === "~" || directory.startsWith("~/")
			? directory.replace(/^~/, homedir())
			: directory;
	return resolve(expanded);
};

const titleForDirectory = (directory: string): string =>
	basename(directory) || "project";

export const saveProject = (input: SaveProjectInput) =>
	Effect.flatMap(ProjectSaveLockTag, (lock) =>
		lock.withPermits(1)(
			Effect.gen(function* () {
				const inputs = input.folders.map((folder) =>
					typeof folder === "string"
						? { path: normalizeProjectDirectory(folder), create: undefined }
						: { ...folder, path: normalizeProjectDirectory(folder.path) },
				);
				const folders = inputs.map((folder) => folder.path);
				const projects = yield* allProjects;
				const existing = projects.find(
					(project) => project.slug === input.slug,
				);
				const { errors, warnings } = checkFolders(
					folders,
					projects.filter((project) => project.slug !== input.slug),
				);
				const issues: FolderIssue[] = [...errors];
				if (input.slug !== undefined && existing === undefined) {
					issues.push({ kind: "unknown-project", slug: input.slug });
				}
				for (const folder of inputs) {
					const disk = yield* Effect.try({
						try: () =>
							folder.create ? lstatSync(folder.path) : statSync(folder.path),
						catch: (cause) => cause,
					}).pipe(Effect.option);
					if (folder.create) {
						if (Option.isSome(disk))
							issues.push({ kind: "create-exists", path: folder.path });
					} else if (Option.isNone(disk)) {
						issues.push({ kind: "missing", path: folder.path });
					} else if (!disk.value.isDirectory()) {
						issues.push({ kind: "not-a-folder", path: folder.path });
					}
				}
				if (issues.length > 0)
					return yield* new ProjectSaveRejected({ issues });
				const directory = folders[0];
				if (directory === undefined)
					return yield* new ProjectSaveRejected({
						issues: [{ kind: "empty" }],
					});
				const title =
					input.title === undefined
						? undefined
						: normalizeProjectTitle(input.title);
				if (title === "")
					return yield* new WsRpcError({
						message: "SaveProject failed: title is required",
					});
				const { configDir } = yield* Ref.get(yield* DaemonStateTag);
				const mainChanged =
					existing !== undefined && existing.directory !== directory;
				if (mainChanged) {
					if (
						projectEventsDbPath({ configDir, ...existing }) !==
						resolve(projectStorageDir(configDir, existing.slug), "events.db")
					) {
						return yield* new WsRpcError({
							message:
								"Project history migration must complete before changing the main folder",
						});
					}
					// A send admitted between this check and the relay swap is not blocked.
					const count = yield* countRunningProjectSessions(
						existing,
						configDir,
					).pipe(
						Effect.mapError(
							(cause) =>
								new WsRpcError({
									message: `Failed to check running sessions: ${formatRelayFailure(cause)}`,
								}),
						),
					);
					if (count > 0)
						return yield* new ProjectSaveRejected({
							issues: [{ kind: "sessions-running", count }],
						});
				}
				const slug =
					existing?.slug ??
					(yield* Effect.try({
						try: () =>
							chooseProjectSlug({
								configDir,
								directory,
								liveSlugs: new Set(projects.map((project) => project.slug)),
							}),
						catch: (cause) =>
							new WsRpcError({
								message: `Failed to read project storage: ${formatRelayFailure(cause)}`,
							}),
					}));
				const created: string[] = [];
				yield* Effect.gen(function* () {
					for (const folder of inputs) {
						if (!folder.create) continue;
						yield* Effect.try({
							try: () => {
								mkdirSync(folder.path);
								created.push(folder.path);
							},
							catch: (cause) =>
								new ProjectSaveRejected({
									issues: [
										{
											kind: "mkdir-failed",
											path: folder.path,
											message: formatRelayFailure(cause),
										},
									],
								}),
						});
						if (folder.create.gitInit) {
							yield* Effect.try({
								try: () =>
									execFileSync("git", ["init"], {
										cwd: folder.path,
										stdio: "pipe",
										timeout: 30_000,
									}),
								catch: (cause) =>
									new ProjectSaveRejected({
										issues: [
											{
												kind: "git-init-failed",
												path: folder.path,
												message: formatRelayFailure(cause),
											},
										],
									}),
							});
						}
					}
				}).pipe(
					Effect.onError(() =>
						Effect.forEach(
							[...created].reverse(),
							(path) =>
								Effect.try({
									try: () => rmSync(path, { recursive: true, force: true }),
									catch: (cause) => cause,
								}).pipe(
									Effect.catchAll((cause) =>
										Effect.logWarning(
											`Failed to remove created folder ${path}: ${formatRelayFailure(cause)}`,
										),
									),
								),
							{ discard: true },
						),
					),
				);
				const project: StoredProject = existing
					? {
							...existing,
							directory,
							folders,
							...(title !== undefined && { title }),
						}
					: {
							slug,
							directory,
							folders,
							title: title ?? titleForDirectory(directory),
							lastUsed: Date.now(),
							...(input.instanceId !== undefined && {
								instanceId: input.instanceId,
							}),
						};
				if (existing) {
					yield* updateProject(slug, {
						directory,
						folders,
						title: project.title,
					});
				} else {
					yield* addWithoutRelay(project);
				}
				if (
					existing &&
					(existing.folders.length !== folders.length ||
						existing.folders.some((folder, index) => folder !== folders[index]))
				) {
					yield* replaceRelay(slug);
					if (mainChanged) {
						yield* stopRegisteredClaudeRunners(
							existing.directory,
							configDir,
						).pipe(
							Effect.catchAllCause((cause) =>
								Effect.logWarning(
									`Failed to stop old project runners after saving ${slug}: ${formatRelayFailure(cause)}`,
								),
							),
						);
					}
				}
				return { project: yield* getProject(slug), warnings };
			}),
		),
	).pipe(
		Effect.uninterruptible,
		Effect.withSpan("projectRegistry.saveProject"),
	);

/** Remove a project from Conduit's persisted registry. */
export const removeProjectFromEffectRegistry = remove;
