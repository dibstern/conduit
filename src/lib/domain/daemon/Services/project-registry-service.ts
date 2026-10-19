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
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import {
	Array as Arr,
	Context,
	Data,
	Duration,
	Effect,
	HashMap,
	Layer,
	Option,
	PubSub,
	Ref,
	Result,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import { getProviderDriver } from "../../../contracts/provider-instance.js";
import {
	DEFAULT_WORKTREE_CLEANUP,
	resolveWorktreeCleanup,
} from "../../../contracts/worktree.js";
import {
	ProjectSaveRejected,
	type ResolveSessionModeResponse,
	type SaveProjectInput,
	WsRpcError,
} from "../../../contracts/ws-rpc.js";
import { readProjectFile } from "../../../daemon/project-file.js";
import { readRepositoryIdentity } from "../../../git/repository-identity.js";
import {
	daemonSessionGitCache,
	withCachedProjectGit,
} from "../../../git/session-git.js";
import { normalizeProjectTitle } from "../../../handlers/settings.js";
import { PersistenceStore } from "../../../persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { SessionRollupProjects } from "../../../persistence/effect/session-rollup-projects.js";
import { refreshSidebar } from "../../../persistence/effect/sidebar-projection.js";
import { chooseProjectSlug } from "../../../persistence/project-storage.js";
import {
	checkFolders,
	type FolderIssue,
	isPermissionDenied,
} from "../../../project-folders.js";
import { stopRegisteredRunners } from "../../../provider/runner/process-session-runner.js";
import { loadRelaySettings } from "../../../relay/relay-settings.js";
import type { StoredProject } from "../../../types.js";
import { SessionEventBusTag } from "../../relay/Services/session-event-bus.js";
import { isConduitWorktreePath } from "../Layers/worktree-layer.js";
import {
	ConfigPersistenceTag,
	requestConfigSave,
} from "./config-persistence-service.js";
import { DaemonConfigRefTag } from "./daemon-config-ref.js";
import { DaemonEvent, DaemonEventBusTag } from "./daemon-pubsub.js";
import { countRunningProjectSessions } from "./daemon-session-reader.js";
import { type DaemonProject, DaemonStateTag } from "./daemon-state.js";
import { DaemonStoreAvailability } from "./daemon-store-availability.js";
import { RelayCacheTag } from "./relay-cache.js";

const PROJECT_REMOVE_ALL_CONCURRENCY = 4;

/** Registration changes affect roots owned by other projects too. */
const refreshProjectRollups = (changedSlugs: readonly string[]) =>
	Effect.gen(function* () {
		const store = yield* Effect.serviceOption(PersistenceStore);
		if (Option.isNone(store)) return;
		const projects = Context.get(store.value, SessionRollupProjects);
		if (projects === undefined) return;
		const sql = Context.get(store.value, SqlClient.SqlClient);
		const runner = Context.get(store.value, ProjectionRunnerEffectTag);
		const unavailable = yield* DaemonStoreAvailability;
		const ref = yield* ProjectRegistryTag;
		const { advance } = yield* sql
			.withTransaction(
				Effect.gen(function* () {
					const registered = [...HashMap.keys(yield* Ref.get(ref))].filter(
						(slug) => !unavailable.has(slug),
					);
					const roots = yield* sql<{ id: string; project_id: string }>`
				SELECT DISTINCT root.id, root.project_id FROM sessions member
				JOIN sessions root ON root.id = member.root_id
				WHERE member.project_id IN ${sql.in(changedSlugs)}`;
					if (roots.length === 0) return { registered, advance: undefined };
					const version = yield* runner.nextVersion.pipe(
						Effect.provideService(SqlClient.SqlClient, sql),
					);
					const sessionIds = roots.map(({ id }) => id);
					yield* refreshSidebar(sessionIds, version, registered).pipe(
						Effect.provideService(SqlClient.SqlClient, sql),
					);
					return {
						registered,
						advance: {
							version,
							sessionIds,
							projectIds: [
								...new Set(roots.map(({ project_id }) => project_id)),
							],
						},
					};
				}),
			)
			.pipe(
				Effect.tap(({ registered }) => Ref.set(projects, registered)),
				Effect.orDie,
				Effect.uninterruptible,
			);
		const bus = yield* Effect.serviceOption(SessionEventBusTag);
		if (advance && Option.isSome(bus))
			yield* bus.value.publishAdvance({
				...advance,
				removedSessionIds: [],
				collections: ["sidebar"],
			});
	});

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
	folders: project.folders,
	title: project.title ?? project.slug,
	lastUsed: project.addedAt,
	...(project.shellEnv !== undefined && { shellEnv: project.shellEnv }),
	...(project.setupScript !== undefined && {
		setupScript: project.setupScript,
	}),
	...(project.sessionMode !== undefined && {
		sessionMode: project.sessionMode,
	}),
	...(project.worktreeCleanup !== undefined && {
		worktreeCleanup: project.worktreeCleanup,
	}),
	...(project.repositoryIdentities !== undefined && {
		repositoryIdentities: project.repositoryIdentities,
	}),
});

const deriveRepositoryIdentities = (folders: readonly string[]) =>
	Effect.forEach(
		folders,
		(folder) =>
			Effect.tryPromise(() => readRepositoryIdentity(folder)).pipe(
				Effect.catch(() => Effect.succeed(undefined)),
				Effect.map((identity) =>
					identity ? ([folder, identity] as const) : undefined,
				),
			),
		{ concurrency: 4 },
	).pipe(
		Effect.map((entries) =>
			Object.fromEntries(entries.filter((entry) => entry !== undefined)),
		),
	);

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

export class ProjectRegistryTag extends Context.Service<
	ProjectRegistryTag,
	Ref.Ref<ProjectRegistryState>
>()("ProjectRegistry") {}

export class ProjectSaveLockTag extends Context.Service<
	ProjectSaveLockTag,
	Semaphore.Semaphore
>()("ProjectSaveLock") {}

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

/** Read current global rules and the project's current daemon-only override. */
export const getEffectiveWorktreeCleanup = (slug: string) =>
	Effect.gen(function* () {
		const project = yield* getProject(slug);
		const config = yield* Ref.get(yield* DaemonConfigRefTag);
		return resolveWorktreeCleanup(
			config.worktreeCleanup ?? DEFAULT_WORKTREE_CLEANUP,
			project.worktreeCleanup,
		);
	});

/** Resolve each draft from the primary folder's current file and persisted defaults. */
export const resolveSessionMode = (slug: string) =>
	Effect.gen(function* () {
		const project = yield* getProject(slug);
		const { configDir } = yield* Ref.get(yield* DaemonStateTag);
		const file = yield* readProjectFile(project.folders[0]);
		const warning = file._tag === "invalid" ? { warning: file.message } : {};
		if (project.sessionMode !== undefined)
			return {
				mode: project.sessionMode,
				source: "project",
				...warning,
			} satisfies ResolveSessionModeResponse;
		if (file._tag === "parsed" && file.file.sessionMode !== undefined)
			return {
				mode: file.file.sessionMode,
				source: "file",
				...warning,
			} satisfies ResolveSessionModeResponse;
		const settings = loadRelaySettings(configDir);
		return {
			mode:
				settings.defaultSessionMode === "last"
					? (settings.lastSessionMode ?? "local")
					: (settings.defaultSessionMode ?? "local"),
			source: "global",
			...warning,
		} satisfies ResolveSessionModeResponse;
	}).pipe(Effect.withSpan("projectRegistry.resolveSessionMode"));

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

/** Find a project entry by its main folder. Returns Option. */
export const findByDirectory = (directory: string) =>
	Effect.gen(function* () {
		const ref = yield* ProjectRegistryTag;
		const state = yield* Ref.get(ref);
		const entries = HashMap.values(state);
		const normalized = normalizeProjectDirectory(directory);
		for (const entry of entries) {
			if (normalizeProjectDirectory(entry.project.folders[0]) === normalized) {
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

export const projectInfos = Effect.gen(function* () {
	const unavailable = yield* DaemonStoreAvailability;
	const ref = yield* ProjectRegistryTag;
	const projects = yield* allProjects;
	// Cold projects need branches too. Share the relay cache and its refresh interval.
	yield* Effect.forEach(
		[...new Set(projects.flatMap(({ folders }) => folders))].filter((folder) =>
			daemonSessionGitCache.isStale(folder),
		),
		(folder) => Effect.tryPromise(() => daemonSessionGitCache.refresh(folder)),
		{ concurrency: 4, discard: true },
	);
	for (const project of projects) {
		if (project.repositoryIdentities !== undefined) continue;
		const repositoryIdentities = yield* deriveRepositoryIdentities(
			project.folders,
		);
		const changed = yield* Ref.modify(ref, (state) => {
			const current = HashMap.get(state, project.slug);
			if (
				Option.isNone(current) ||
				current.value.project.folders !== project.folders ||
				current.value.project.repositoryIdentities !== undefined
			)
				return [false, state] as const;
			return [
				true,
				HashMap.set(state, project.slug, {
					...current.value,
					project: { ...current.value.project, repositoryIdentities },
				}),
			] as const;
		});
		if (changed) {
			const persistence = yield* Effect.serviceOption(ConfigPersistenceTag);
			if (Option.isSome(persistence)) yield* persistence.value.requestSave;
		}
	}
	return withCachedProjectGit(
		(yield* allProjects).map((project) => {
			const unavailableReason = unavailable.get(project.slug);
			return {
				slug: project.slug,
				...(unavailableReason !== undefined && { unavailableReason }),
				folders: project.folders,
				title: project.title,
				...(project.setupScript !== undefined && {
					setupScript: project.setupScript,
				}),
				...(project.sessionMode !== undefined && {
					sessionMode: project.sessionMode,
				}),
				...(project.repositoryIdentities !== undefined && {
					repositoryIdentities: project.repositoryIdentities,
				}),
				...(project.lastUsed !== undefined && { lastUsed: project.lastUsed }),
			};
		}),
	);
});

export const broadcastProjectList = Effect.gen(function* () {
	yield* PubSub.publish(
		yield* DaemonEventBusTag,
		DaemonEvent.ProjectsChanged(),
	);
	return yield* projectInfos;
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
		const entry: ProjectRegistering = { _tag: "Registering", project };

		// Atomic check-and-set via Ref.modify
		const alreadyExists = yield* Ref.modify(ref, (state) => {
			if (HashMap.has(state, project.slug)) {
				return [true, state] as const;
			}
			return [false, HashMap.set(state, project.slug, entry)] as const;
		});

		if (alreadyExists) {
			return yield* new ProjectAlreadyExists({ slug: project.slug });
		}
		yield* refreshProjectRollups([project.slug]).pipe(
			Effect.onError(() =>
				Ref.update(ref, (state) =>
					Option.exists(
						HashMap.get(state, project.slug),
						(current) => current === entry,
					)
						? HashMap.remove(state, project.slug)
						: state,
				),
			),
		);

		if (!options?.silent) {
			yield* PubSub.publish(
				bus,
				DaemonEvent.InstanceAdded({ instanceId: project.slug }),
			);
		}

		yield* requestConfigSave;
		yield* Effect.logInfo("Project registered");
	}).pipe(
		Effect.uninterruptible,
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
					yield* stopRegisteredRunners(
						removed.value.project.folders[0],
						state.configDir,
					);
					yield* refreshProjectRollups([slug]);
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
 * Update project fields. Publishes InstanceStatusChanged.
 * Fails with ProjectNotFound if slug not registered.
 */
export const updateProject = (
	slug: string,
	updates: Partial<
		Pick<
			StoredProject,
			| "title"
			| "folders"
			| "repositoryIdentities"
			| "setupScript"
			| "sessionMode"
			| "worktreeCleanup"
		>
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
			Effect.catch((cause) => markError(slug, formatRelayFailure(cause))),
			Effect.catchDefect((defect) =>
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
	yield* refreshProjectRollups(allSlugs);

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

		yield* Stream.fromSubscription(sub).pipe(
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
			Effect.catch((cause) => markError(slug, formatRelayFailure(cause))),
			Effect.catchDefect((defect) =>
				markError(slug, formatRelayFailure(defect)),
			),
		);
	}).pipe(
		Effect.annotateLogs("slug", slug),
		Effect.withSpan("projectRegistry.replaceRelay"),
	);

/** The first configured OpenCode endpoint drives the relay's default sessions. */
export const openCodeInstanceFor = <
	I extends {
		id: string;
		driver?: string;
		managed?: boolean;
		port?: number;
		url?: string;
	},
>(
	instances: readonly I[],
): I | undefined =>
	instances.find((instance) => {
		if (!getProviderDriver(instance.driver ?? "opencode")?.runsOpenCodeServer)
			return false;
		if (instance.managed === true || (instance.port ?? 0) > 0) return true;
		if (instance.url !== undefined)
			return URL.canParse(instance.url) && new URL(instance.url).port !== "0";
		return instance.port === undefined;
	});

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
			const lock = yield* Semaphore.make(1);
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
		// Refresh even cached identities before consumers (including HTTP/RPC) start.
		const initialProjects = yield* Effect.forEach(
			state.projects,
			(project) =>
				deriveRepositoryIdentities(project.folders).pipe(
					Effect.map((repositoryIdentities) => ({
						...toStoredProject(project),
						repositoryIdentities,
					})),
				),
			{ concurrency: 4 },
		);
		const ref = yield* Ref.make<ProjectRegistryState>(
			makeInitialProjectState(initialProjects),
		);
		const lock = yield* Semaphore.make(1);
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
	const path = resolve(expanded);
	try {
		return realpathSync(path);
	} catch {
		// Missing paths may be created; save validation reports inaccessible paths.
		return path;
	}
};

const titleForDirectory = (directory: string): string =>
	basename(directory) || "project";

export const saveProject = (input: SaveProjectInput) =>
	Effect.flatMap(ProjectSaveLockTag, (lock) =>
		lock.withPermits(1)(
			Effect.gen(function* () {
				const { configDir } = yield* Ref.get(yield* DaemonStateTag);
				const inputs = input.folders.map((folder) => {
					const path = typeof folder === "string" ? folder : folder.path;
					return {
						...(typeof folder === "string" ? {} : folder),
						path: normalizeProjectDirectory(path),
						originalPath: path.replace(/^~(?=\/|$)/, homedir()),
					};
				});
				const folders = inputs.map((folder) => folder.path);
				const projects = yield* allProjects;
				const existing = projects.find(
					(project) => project.slug === input.slug,
				);
				const { errors, warnings } = checkFolders(
					folders,
					projects
						.filter((project) => project.slug !== input.slug)
						.map((project) => ({
							...project,
							folders: project.folders.map(normalizeProjectDirectory),
						})),
				);
				const taken = errors.find((issue) => issue.kind === "main-taken");
				const issues: FolderIssue[] = errors.filter(
					(issue) => input.slug !== undefined || issue.kind !== "main-taken",
				);
				if (input.slug !== undefined && existing === undefined) {
					issues.push({ kind: "unknown-project", slug: input.slug });
				}
				for (const folder of inputs) {
					const owned = yield* Effect.try({
						try: () => isConduitWorktreePath(configDir, folder.originalPath),
						catch: (cause): FolderIssue => ({
							kind: isPermissionDenied(cause) ? "permission-denied" : "missing",
							path: folder.path,
						}),
					}).pipe(Effect.result);
					if (Result.isFailure(owned)) {
						issues.push(owned.failure);
						continue;
					}
					if (owned.success) {
						issues.push({
							kind: "conduit-worktree",
							path: folder.originalPath,
						});
						continue;
					}
					const disk = yield* Effect.try({
						try: () => {
							const disk = folder.create
								? lstatSync(folder.path)
								: statSync(folder.path);
							if (!folder.create && disk.isDirectory())
								readdirSync(folder.path);
							return disk;
						},
						catch: (cause): FolderIssue => ({
							kind: isPermissionDenied(cause) ? "permission-denied" : "missing",
							path: folder.path,
						}),
					}).pipe(Effect.result);
					if (Result.isFailure(disk)) {
						if (!folder.create || disk.failure.kind === "permission-denied")
							issues.push(disk.failure);
					} else if (folder.create) {
						issues.push({ kind: "create-exists", path: folder.path });
					} else if (!disk.success.isDirectory()) {
						issues.push({ kind: "not-a-folder", path: folder.path });
					}
				}
				if (issues.length > 0)
					return yield* new ProjectSaveRejected({ issues });
				if (input.slug === undefined && taken?.kind === "main-taken")
					return {
						kind: "existing" as const,
						project: yield* getProject(taken.slug),
						warnings: [],
					};
				if (!Arr.isReadonlyArrayNonEmpty(folders))
					return yield* new ProjectSaveRejected({
						issues: [{ kind: "empty" }],
					});
				const mainFolder = folders[0];
				const title =
					input.title === undefined
						? undefined
						: normalizeProjectTitle(input.title);
				if (title === "")
					return yield* new WsRpcError({
						message: "SaveProject failed: title is required",
					});
				const mainChanged =
					existing !== undefined &&
					normalizeProjectDirectory(existing.folders[0]) !== mainFolder;
				if (mainChanged) {
					// Startup finds legacy history through the main folder, so moving it
					// would orphan history that has not been imported yet.
					const unavailableReason = (yield* DaemonStoreAvailability).get(
						existing.slug,
					);
					if (unavailableReason !== undefined)
						return yield* new WsRpcError({
							message: `Fix this project's history before changing its main folder: ${unavailableReason}`,
						});
					// A send admitted between this check and the relay swap is not blocked.
					const count = yield* countRunningProjectSessions(existing).pipe(
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
								mainFolder,
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
										env: {
											...process.env,
											GIT_DIR: undefined,
											GIT_INDEX_FILE: undefined,
										},
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
									Effect.catch((cause) =>
										Effect.logWarning(
											`Failed to remove created folder ${path}: ${formatRelayFailure(cause)}`,
										),
									),
								),
							{ discard: true },
						),
					),
				);
				const canonicalFolders = Arr.map(folders, normalizeProjectDirectory);
				const repositoryIdentities =
					yield* deriveRepositoryIdentities(canonicalFolders);
				const setupScript =
					input.setupScript === undefined
						? existing?.setupScript
						: input.setupScript.trim()
							? input.setupScript
							: undefined;
				const sessionMode =
					input.sessionMode === undefined
						? existing?.sessionMode
						: (input.sessionMode ?? undefined);
				const project: StoredProject = existing
					? {
							...existing,
							folders: canonicalFolders,
							repositoryIdentities,
							setupScript,
							sessionMode,
							...(title !== undefined && { title }),
						}
					: {
							slug,
							folders: canonicalFolders,
							repositoryIdentities,
							setupScript,
							sessionMode,
							title: title ?? titleForDirectory(mainFolder),
							lastUsed: Date.now(),
						};
				if (existing) {
					yield* updateProject(slug, {
						folders: canonicalFolders,
						repositoryIdentities,
						title: project.title,
						setupScript,
						sessionMode,
					});
				} else {
					yield* addWithoutRelay(project);
				}
				if (
					existing &&
					(existing.folders.length !== canonicalFolders.length ||
						existing.folders.some(
							(folder, index) =>
								normalizeProjectDirectory(folder) !== canonicalFolders[index],
						))
				) {
					yield* replaceRelay(slug);
					if (mainChanged) {
						yield* stopRegisteredRunners(existing.folders[0], configDir).pipe(
							Effect.catchCause((cause) =>
								Effect.logWarning(
									`Failed to stop old project runners after saving ${slug}: ${formatRelayFailure(cause)}`,
								),
							),
						);
					}
				}
				return { kind: undefined, project: yield* getProject(slug), warnings };
			}),
		),
	).pipe(
		Effect.uninterruptible,
		Effect.withSpan("projectRegistry.saveProject"),
	);

/** Remove a project from Conduit's persisted registry. */
export const removeProjectFromEffectRegistry = remove;
