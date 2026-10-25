import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	Clock,
	type Context,
	Deferred,
	Effect,
	HashMap,
	Option,
	PubSub,
	Queue,
	Ref,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import {
	type SessionWorkspace,
	SessionWorkspaceSchema,
} from "../../../contracts/session-workspace.js";
import {
	type WorkspaceMissing,
	WorkspaceMissingSchema,
} from "../../../contracts/worktree.js";
import { makeUnboundCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import {
	type CanonicalDirectory,
	canonicalDirectory,
	forgetCanonicalDirectory,
	readPublishedSessionGit,
} from "../../../persistence/effect/session-git-publication.js";
import {
	readSessionWorktreeOwnershipSnapshot,
	recordedBranchForFolder,
} from "../../../persistence/effect/session-worktree-ownership.js";
import {
	effectiveSessionFolders,
	effectiveWorkingDirectory,
} from "../../../session/session-workspace.js";
import {
	type SessionGit as GitState,
	SessionGitSchema,
} from "../../../shared-types.js";
import { SessionEventBusTag } from "../../relay/Services/session-event-bus.js";
import { OwnerScopes } from "../Services/owner-scopes.js";
import { ProjectRegistryTag } from "../Services/project-registry-service.js";
import { ReadRequest } from "../Services/read-request.js";
import { SessionActivityTag } from "../Services/session-activity.js";
import type { SessionGit, SessionGitChange } from "../Services/session-git.js";
import { Subprocess, SubprocessPriority } from "../Services/subprocess.js";
import { WorktreeServiceTag } from "../Services/worktree-service.js";
import { makeSessionGitReader } from "./session-git/git-reader.js";

type Tier = "running" | "viewed" | "listed" | "dormant";
const intervals = {
	running: 15_000,
	viewed: 5_000,
	listed: 30_000,
	dormant: Number.POSITIVE_INFINITY,
} satisfies Record<Tier, number>;
const probeIntervals = {
	running: 1_000,
	viewed: 500,
	listed: 5_000,
	dormant: 10_000,
} satisfies Record<Tier, number>;
const hintThrottleMs = 2_000;
// Listed polling is a safety net for changes outside the probe targets, at one
// daemon-wide rate (oldest first) rather than a per-folder cost that grows
// with every listed session.
const safetyNetGapMs = 20_000;

interface Membership {
	readonly sessionId: string;
	readonly projectId: string;
	readonly folders: readonly string[];
	readonly workspace: SessionWorkspace | null;
	readonly directories: readonly CanonicalDirectory[];
	running: boolean;
	listedUntil: number;
}
interface DirectoryState {
	readonly directory: CanonicalDirectory;
	readonly sessions: Set<string>;
	readonly projects: Set<string>;
	readonly probes: Map<string, { stamp: string; contents: string | undefined }>;
	readonly first: Deferred.Deferred<void>;
	readonly abort: AbortController;
	readonly rootProjects: Set<string>;
	repositoryDirectory?: string;
	gitDirectory?: string;
	git: GitState | undefined;
	workspaceMissing: WorkspaceMissing | undefined;
	published: boolean;
	needsCanonicalPublication: boolean;
	lastRead: number;
	lastHintRead: number;
	lastProbe: number;
	listedUntil: number;
	present: boolean | undefined;
	hinted: boolean;
	/** A hint arrived since presence was last checked. */
	presenceUnchecked: boolean;
	forced: boolean;
	queued: boolean;
}

/** One daemon owner: all callers see committed publications, never raw reads. */
export const makeSessionGit = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const registry = yield* ProjectRegistryTag;
	const owners = yield* OwnerScopes;
	const subprocess = yield* Subprocess;
	const runner = subprocess.makeRunner();
	const reader = makeSessionGitReader();
	const commit = yield* makeUnboundCommitAndSignal;
	const activity = yield* Effect.serviceOption(SessionActivityTag);
	const events = yield* Effect.serviceOption(SessionEventBusTag);
	const worktrees = yield* Effect.serviceOption(WorktreeServiceTag);
	const changes = yield* Effect.acquireRelease(
		PubSub.unbounded<SessionGitChange>(),
		PubSub.shutdown,
	);
	const queue = yield* Effect.acquireRelease(
		Queue.unbounded<DirectoryState>(),
		Queue.shutdown,
	);
	const membershipLock = yield* Semaphore.make(1);
	const publicationLock = yield* Semaphore.make(1);
	const directories = new Map<CanonicalDirectory, DirectoryState>();
	const sessions = new Map<string, Membership>();
	const pendingSessions = new Set<string>();
	const pendingReads = new Set<string>();
	const pendingListed = new Map<string, number>();
	const pendingDirectories = new Map<
		CanonicalDirectory,
		{ listedUntil: number; invalidated: boolean }
	>();
	let readQuietUntil = 0;
	let lastSafetyNet = Number.NEGATIVE_INFINITY;
	const decodeWorkspace = Schema.decodeUnknownOption(
		Schema.fromJsonString(SessionWorkspaceSchema),
	);
	const decodeGit = Schema.decodeUnknownOption(
		Schema.fromJsonString(SessionGitSchema),
	);
	const decodeMissing = Schema.decodeUnknownOption(
		Schema.fromJsonString(WorkspaceMissingSchema),
	);
	const initial = new Map<
		CanonicalDirectory,
		{ git: GitState | undefined; missing: WorkspaceMissing | undefined }
	>();
	const legacyAliases = new Map<CanonicalDirectory, string[]>();
	for (const row of yield* sql<{
		directory: string;
		git: string | null;
		workspace_missing: string | null;
	}>`SELECT directory, git, workspace_missing FROM session_git_published`) {
		const git = row.git === null ? Option.some(undefined) : decodeGit(row.git);
		if (Option.isNone(git)) continue;
		const key = canonicalDirectory(row.directory);
		if (key !== row.directory)
			legacyAliases.set(key, [
				...(legacyAliases.get(key) ?? []),
				row.directory,
			]);
		if (key !== row.directory && initial.has(key)) continue;
		initial.set(key, {
			git: git.value,
			missing:
				row.workspace_missing === null
					? undefined
					: Option.getOrUndefined(decodeMissing(row.workspace_missing)),
		});
	}

	const tier = (entry: DirectoryState, now: number): Tier => {
		let listed = entry.listedUntil > now;
		let running = false;
		for (const id of entry.sessions) {
			const session = sessions.get(id);
			if (!session) continue;
			if (Option.isSome(activity) && (activity.value.viewers.get(id) ?? 0) > 0)
				return "viewed";
			running ||= session.running;
			listed ||= session.listedUntil > now;
		}
		return running ? "running" : listed ? "listed" : "dormant";
	};
	const request = (entry: DirectoryState, force = false) => {
		entry.hinted = true;
		entry.presenceUnchecked = true;
		entry.forced ||= force;
	};
	const present = (directory: string) =>
		Effect.tryPromise(() => lstat(directory)).pipe(
			Effect.map((stat) => stat.isDirectory()),
			Effect.orElseSucceed(() => false),
		);
	const checkPresence = (entry: DirectoryState) =>
		Effect.gen(function* () {
			const exists = yield* present(entry.directory);
			if (entry.present !== undefined && exists !== entry.present) {
				forgetCanonicalDirectory(entry.directory);
				request(entry, true);
			}
			return exists;
		});
	const readText = (path: string) =>
		Effect.tryPromise((signal) =>
			readFile(path, { encoding: "utf8", signal }),
		).pipe(Effect.orElseSucceed(() => undefined));
	const probeStamp = (path: string) =>
		Effect.tryPromise(() => stat(path)).pipe(
			Effect.map(
				(file) =>
					`${file.isDirectory() ? "directory" : "file"}:${file.mtimeMs}:${file.ctimeMs}:${file.size}:${file.ino}:${file.nlink}`,
			),
			Effect.orElseSucceed(() => "missing"),
		);
	const setProbeTargets = (entry: DirectoryState) =>
		Effect.gen(function* () {
			const dotgit = join(entry.directory, ".git");
			const pointer = (yield* readText(dotgit))
				?.trim()
				.replace(/^gitdir: /, "");
			const gitDir = pointer
				? isAbsolute(pointer)
					? pointer
					: resolve(entry.directory, pointer)
				: dotgit;
			const common = (yield* readText(join(gitDir, "commondir")))?.trim();
			const refDir = common ? resolve(gitDir, common) : gitDir;
			entry.gitDirectory = gitDir;
			entry.repositoryDirectory = yield* Effect.tryPromise(() =>
				realpath(refDir),
			).pipe(Effect.orElseSucceed(() => refDir));
			const head = join(gitDir, "HEAD");
			// Derive the branch from the baseline itself: rereading HEAD here
			// could pair one branch's targets with another branch's contents.
			const headProbe = entry.probes.get(head) ?? {
				stamp: yield* probeStamp(head),
				contents: yield* readText(head),
			};
			entry.probes.set(head, headProbe);
			const branch = /^ref: refs\/heads\/(.+)$/.exec(
				headProbe.contents?.trim() ?? "",
			)?.[1];
			// Exact loose refs include nested names such as wt/foo. Their parent
			// refs/heads directory does not change when an existing ref is replaced.
			const targets = new Set([
				entry.directory,
				head,
				join(gitDir, "index"),
				join(gitDir, "packed-refs"),
				join(refDir, "packed-refs"),
				...[branch, "main", "master"].flatMap((ref) =>
					ref === undefined ? [] : [join(refDir, "refs", "heads", ref)],
				),
			]);
			for (const path of entry.probes.keys())
				if (!targets.has(path)) entry.probes.delete(path);
			for (const path of targets) {
				if (entry.probes.has(path)) continue;
				const stamp = yield* probeStamp(path);
				const contents =
					path === entry.directory || path === join(gitDir, "index")
						? undefined
						: yield* readText(path);
				entry.probes.set(path, { stamp, contents });
			}
		});
	const probe = (entry: DirectoryState) =>
		Effect.gen(function* () {
			if (entry.abort.signal.aborted) return;
			let retarget = false;
			for (const [path, previous] of entry.probes) {
				const stamp = yield* probeStamp(path);
				if (stamp === previous.stamp) continue;
				if (path === entry.directory) {
					const flipped =
						stamp.startsWith("directory:") !==
						previous.stamp.startsWith("directory:");
					if (flipped) {
						forgetCanonicalDirectory(entry.directory);
						retarget = true;
					}
					request(entry, flipped);
				} else if (path === join(entry.gitDirectory ?? "", "index")) {
					request(entry);
				} else {
					// Atomic rewrites and stat-only changes are common. Ref changes
					// force git only when the file's contents actually moved.
					const contents = yield* readText(path);
					if (contents !== previous.contents) {
						request(entry, true);
						if (path === join(entry.gitDirectory ?? "", "HEAD"))
							retarget = true;
					}
					previous.contents = contents;
				}
				previous.stamp = stamp;
			}
			if (retarget) yield* setProbeTargets(entry);
		}).pipe(
			Effect.raceFirst(
				Effect.callback<void>((resume) => {
					const cancel = () => resume(Effect.void);
					if (entry.abort.signal.aborted) cancel();
					else
						entry.abort.signal.addEventListener("abort", cancel, {
							once: true,
						});
					return Effect.sync(() =>
						entry.abort.signal.removeEventListener("abort", cancel),
					);
				}),
			),
		);
	const releaseWatches = (entry: DirectoryState) => {
		entry.abort.abort();
		entry.probes.clear();
		if (
			![...directories.values()].some(
				(other) =>
					other !== entry &&
					other.repositoryDirectory === entry.repositoryDirectory,
			)
		)
			reader.invalidate(entry.repositoryDirectory ?? entry.directory);
	};
	const releaseMembership = (session: Membership) => {
		for (const key of session.directories) {
			const entry = directories.get(key);
			entry?.sessions.delete(session.sessionId);
			if (entry) disposeUnused(entry);
		}
	};
	const disposeUnused = (entry: DirectoryState) => {
		if (
			entry.projects.size > 0 &&
			(entry.sessions.size > 0 || entry.rootProjects.size > 0)
		)
			return;
		releaseWatches(entry);
		if (directories.get(entry.directory) === entry)
			directories.delete(entry.directory);
	};
	const getDirectory = (
		directory: CanonicalDirectory,
	): Effect.Effect<DirectoryState> =>
		Effect.gen(function* () {
			const existing = directories.get(directory);
			if (existing) return existing;
			const seed = initial.get(directory);
			const entry: DirectoryState = {
				directory,
				sessions: new Set(),
				projects: new Set(),
				probes: new Map(),
				first: yield* Deferred.make<void>(),
				abort: new AbortController(),
				rootProjects: new Set(),
				git: seed?.git,
				workspaceMissing: seed?.missing,
				published: seed !== undefined,
				needsCanonicalPublication: legacyAliases.has(directory),
				lastRead: Number.NEGATIVE_INFINITY,
				lastHintRead: Number.NEGATIVE_INFINITY,
				lastProbe: Number.NEGATIVE_INFINITY,
				listedUntil: 0,
				present: undefined,
				hinted: false,
				presenceUnchecked: false,
				forced: false,
				queued: false,
			};
			yield* setProbeTargets(entry);
			directories.set(directory, entry);
			return entry;
		});
	const holdDirectory = (
		entry: DirectoryState,
		projectId: string,
	): Effect.Effect<void, unknown> =>
		Effect.gen(function* () {
			if (entry.projects.has(projectId)) return;
			const owner = yield* owners.projectScope(projectId);
			yield* owner.acquire<void, never, never>(
				Effect.acquireRelease(
					Effect.sync(() => {
						entry.projects.add(projectId);
					}),
					() =>
						Effect.sync(() => {
							entry.projects.delete(projectId);
							entry.rootProjects.delete(projectId);
							disposeUnused(entry);
						}),
				),
			);
		});
	let registeredProjects = yield* Ref.get(registry);
	let projectsInitialized = false;
	const registerProjectFolders = membershipLock.withPermits(1)(
		Effect.gen(function* () {
			const current = yield* Ref.get(registry);
			if (projectsInitialized && current === registeredProjects) return;
			registeredProjects = current;
			projectsInitialized = true;
			const roots = new Map(
				[...current].map(([projectId, project]) => [
					projectId,
					new Set(project.project.folders.map(canonicalDirectory)),
				]),
			);
			for (const entry of directories.values()) {
				for (const projectId of entry.rootProjects)
					if (!roots.get(projectId)?.has(entry.directory))
						entry.rootProjects.delete(projectId);
				disposeUnused(entry);
			}
			for (const [projectId, project] of current)
				for (const folder of project.project.folders) {
					const entry = yield* getDirectory(canonicalDirectory(folder));
					if (
						entry.rootProjects.has(projectId) &&
						entry.projects.has(projectId)
					)
						continue;
					yield* holdDirectory(entry, projectId);
					if (!entry.projects.has(projectId) || entry.abort.signal.aborted)
						continue;
					entry.rootProjects.add(projectId);
					if (!Number.isFinite(entry.lastRead)) request(entry, true);
				}
		}).pipe(
			Effect.catch((error) =>
				Effect.logDebug("Session git project owner unavailable", error),
			),
		),
	);
	const attach = (sessionId: string): Effect.Effect<Membership | undefined> =>
		membershipLock.withPermits(1)(
			Effect.gen(function* () {
				const [row] = yield* sql<{
					project_id: string;
					workspace: string | null;
					status: string;
					settled_at: number | null;
				}>`SELECT project_id, workspace, status, settled_at FROM sessions WHERE id = ${sessionId}`;
				if (!row) return undefined;
				const project = HashMap.get(yield* Ref.get(registry), row.project_id);
				if (Option.isNone(project)) return undefined;
				const folders = project.value.project.folders;
				const workspace =
					row.workspace === null
						? null
						: Option.getOrNull(decodeWorkspace(row.workspace));
				const keys = [
					...new Set(
						[
							effectiveWorkingDirectory(folders[0] ?? "", workspace),
							...effectiveSessionFolders(folders, workspace).map(
								({ directory }) => directory,
							),
						].map(canonicalDirectory),
					),
				];
				const previous = sessions.get(sessionId);
				if (previous && isDeepStrictEqual(previous.directories, keys)) {
					previous.running = row.status === "busy" || row.status === "retry";
					return previous;
				}
				const owner = yield* owners.sessionScope(sessionId);
				// Keep probe baselines for directories the session still uses.
				if (previous)
					releaseMembership({
						...previous,
						directories: previous.directories.filter(
							(key) => !keys.includes(key),
						),
					});
				const session: Membership = {
					sessionId,
					projectId: row.project_id,
					folders,
					workspace,
					directories: keys,
					running: row.status === "busy" || row.status === "retry",
					listedUntil: previous?.listedUntil ?? 0,
				};
				yield* owner.acquire<void, never, never>(
					Effect.acquireRelease(
						Effect.sync(() => {
							sessions.set(sessionId, session);
						}),
						() =>
							Effect.sync(() => {
								if (sessions.get(sessionId) !== session) return;
								sessions.delete(sessionId);
								releaseMembership(session);
							}),
					),
				);
				for (const key of keys) {
					const entry = yield* getDirectory(key);
					entry.sessions.add(sessionId);
					yield* holdDirectory(entry, row.project_id);
				}
				return session;
			}).pipe(
				Effect.catch((error) =>
					Effect.logDebug("Session git owner unavailable", error).pipe(
						Effect.as(undefined),
					),
				),
			),
		);

	const missingState = (entry: DirectoryState, exists: boolean) =>
		Effect.gen(function* () {
			if (!exists && entry.present === exists) return entry.workspaceMissing;
			for (const id of entry.sessions) {
				const session = sessions.get(id);
				if (session?.workspace?.origin !== "conduit") continue;
				const pair = Object.entries(session.workspace.worktrees).find(
					([, path]) => canonicalDirectory(path) === entry.directory,
				);
				if (!pair) continue;
				if (exists) {
					const checkout = yield* Effect.tryPromise(() =>
						lstat(join(entry.directory, ".git")),
					).pipe(
						Effect.map((stat) => stat.isFile()),
						Effect.orElseSucceed(() => false),
					);
					if (checkout) return undefined;
				}
				if (Option.isNone(worktrees))
					return {
						path: entry.directory,
						canRecreate: false,
						reason: "git-failed" as const,
					};
				const ownership = yield* readSessionWorktreeOwnershipSnapshot(
					session.projectId,
					id,
				).pipe(Effect.provideService(SqlClient.SqlClient, sql));
				const recordedBranch =
					ownership?._tag === "Owned"
						? recordedBranchForFolder(ownership.ownership, ...pair)
						: undefined;
				return yield* worktrees.value
					.inspectMissing(
						{ path: pair[0], projectSlug: session.projectId, sessionId: id },
						entry.directory,
						Object.keys(session.workspace.worktrees),
						recordedBranch,
					)
					.pipe(
						Effect.provideService(SubprocessPriority, "background"),
						Effect.orElseSucceed(() => ({
							path: entry.directory,
							canRecreate: false,
							reason: "git-failed" as const,
						})),
					);
			}
			return undefined;
		});
	const refresh = (entry: DirectoryState) =>
		Effect.gen(function* () {
			if (
				directories.get(entry.directory) !== entry ||
				(entry.sessions.size === 0 && entry.rootProjects.size === 0)
			)
				return;
			entry.forced = false;
			entry.hinted = false;
			entry.presenceUnchecked = false;
			const exists = yield* present(entry.directory);
			if (entry.present !== undefined && exists !== entry.present)
				forgetCanonicalDirectory(entry.directory);
			const workspaceMissing = yield* missingState(entry, exists);
			const git = exists
				? yield* Effect.tryPromise({
						try: (signal) =>
							reader.read(
								entry.directory,
								entry.git,
								(command, args, options) =>
									runner(
										command,
										args,
										{ ...options, priority: "background" },
										AbortSignal.any([signal, entry.abort.signal]),
									),
							),
						catch: (cause) => cause,
					})
				: undefined;
			// Cadence runs from when git answered, not from queue wait or publication.
			const readAt = yield* Clock.currentTimeMillis;
			if (
				directories.get(entry.directory) !== entry ||
				entry.abort.signal.aborted
			)
				return;
			if (
				!entry.published ||
				entry.needsCanonicalPublication ||
				!isDeepStrictEqual(entry.git, git) ||
				!isDeepStrictEqual(entry.workspaceMissing, workspaceMissing)
			)
				yield* publicationLock.withPermits(1)(
					Effect.gen(function* () {
						if (
							directories.get(entry.directory) !== entry ||
							entry.abort.signal.aborted
						)
							return;
						let version = 0;
						const ids = yield* commit.write((_project, stamp) =>
							directories.get(entry.directory) !== entry ||
							entry.abort.signal.aborted
								? Effect.succeed(undefined)
								: stamp((nextVersion) =>
										Effect.gen(function* () {
											version = nextVersion;
											yield* sql`INSERT INTO session_git_published (directory, git, workspace_missing, version) VALUES (${entry.directory}, ${git === undefined ? null : JSON.stringify(git)}, ${workspaceMissing === undefined ? null : JSON.stringify(workspaceMissing)}, ${version}) ON CONFLICT (directory) DO UPDATE SET git = excluded.git, workspace_missing = excluded.workspace_missing, version = excluded.version`;
											const aliases = legacyAliases.get(entry.directory);
											if (aliases?.length)
												yield* sql`DELETE FROM session_git_published WHERE directory IN ${sql.in(aliases)}`;
											const projects = yield* Ref.get(registry);
											const projectIds = [...HashMap.keys(projects)];
											if (projectIds.length === 0) return [];
											const rows = yield* sql<{
												id: string;
												project_id: string;
												workspace: string | null;
											}>`SELECT id, project_id, workspace FROM sessions WHERE project_id IN ${sql.in(projectIds)}`;
											const affected: string[] = [];
											for (const row of rows) {
												const project = HashMap.get(projects, row.project_id);
												if (Option.isNone(project)) continue;
												const workspace =
													row.workspace === null
														? null
														: Option.getOrNull(decodeWorkspace(row.workspace));
												if (
													canonicalDirectory(
														effectiveWorkingDirectory(
															project.value.project.folders[0] ?? "",
															workspace,
														),
													) === entry.directory ||
													effectiveSessionFolders(
														project.value.project.folders,
														workspace,
													).some(
														({ directory }) =>
															canonicalDirectory(directory) === entry.directory,
													)
												)
													affected.push(row.id);
											}
											if (affected.length === 0) return [];
											yield* sql`UPDATE sessions SET version = ${version} WHERE id IN ${sql.in(affected)}`;
											// Git is decorated after reading the stored sidebar row, so its
											// content comparator cannot see this change. Stamp its family
											// explicitly, in this transaction, without moving recency.
											yield* sql`UPDATE session_sidebar SET version = ${version}, row = json_set(row, '$.version', ${version}) WHERE session_id IN (SELECT root_id FROM sessions WHERE id IN ${sql.in(affected)})`;
											return affected;
										}),
									),
						);
						if (
							ids === undefined ||
							directories.get(entry.directory) !== entry ||
							entry.abort.signal.aborted
						)
							return;
						entry.git = git;
						entry.workspaceMissing = workspaceMissing;
						entry.published = true;
						entry.needsCanonicalPublication = false;
						initial.set(entry.directory, { git, missing: workspaceMissing });
						legacyAliases.delete(entry.directory);
						yield* PubSub.publish(changes, {
							directory: entry.directory,
							sessionIds: ids,
							version,
						});
					}),
				);
			entry.present = exists;
			entry.lastRead = readAt;
			yield* Deferred.succeed(entry.first, undefined);
		}).pipe(
			Effect.raceFirst(
				Effect.callback<void>((resume) => {
					const cancel = () => resume(Effect.void);
					if (entry.abort.signal.aborted) cancel();
					else
						entry.abort.signal.addEventListener("abort", cancel, {
							once: true,
						});
					return Effect.sync(() =>
						entry.abort.signal.removeEventListener("abort", cancel),
					);
				}),
			),
			Effect.catch((error) =>
				Effect.logWarning("Session git refresh failed", error),
			),
			Effect.ensuring(
				Effect.sync(() => {
					entry.queued = false;
				}).pipe(Effect.andThen(Deferred.succeed(entry.first, undefined))),
			),
		);
	for (let worker = 0; worker < 4; worker++)
		yield* Effect.forever(Effect.flatMap(Queue.take(queue), refresh)).pipe(
			Effect.forkScoped,
		);
	const enqueue = (entry: DirectoryState) =>
		Effect.gen(function* () {
			if (entry.queued) return;
			entry.queued = true;
			yield* Queue.offer(queue, entry);
		});
	const schedule = Effect.gen(function* () {
		yield* registerProjectFolders;
		// Filesystem checks come before reading the clock, so every decision
		// below uses the time it is made at. A hint that waits for its tier's
		// cadence is checked once, not on every tick.
		for (const entry of directories.values())
			if (entry.presenceUnchecked && !entry.forced && !entry.queued) {
				entry.presenceUnchecked = false;
				yield* checkPresence(entry);
			}
		const now = yield* Clock.currentTimeMillis;
		for (const [key, { listedUntil, invalidated }] of pendingDirectories) {
			if (listedUntil > 0 && now < readQuietUntil) continue;
			const entry = directories.get(key);
			if (entry) {
				entry.listedUntil = Math.max(entry.listedUntil, listedUntil);
				// Stale published state is the schedule's job: refreshing every stale
				// folder a list read touches would turn one sidebar read into a burst.
				if (invalidated || (!entry.queued && !entry.published)) request(entry);
			}
			pendingDirectories.delete(key);
		}
		const hints = new Set(pendingSessions);
		const reads = now >= readQuietUntil ? [...pendingReads] : [];
		for (const id of reads) pendingReads.delete(id);
		pendingSessions.clear();
		for (const id of new Set([...hints, ...reads])) {
			const session = yield* attach(id);
			if (session) {
				session.listedUntil = Math.max(
					session.listedUntil,
					pendingListed.get(id) ?? 0,
				);
				pendingListed.delete(id);
				for (const key of session.directories) {
					const entry = directories.get(key);
					if (entry && (hints.has(id) || (!entry.queued && !entry.published)))
						request(entry);
				}
			}
			pendingListed.delete(id);
		}
		if (pendingReads.size === 0 && pendingDirectories.size === 0)
			readQuietUntil = 0;
		let safetyNet: DirectoryState | undefined;
		for (const entry of directories.values()) {
			if (
				(entry.sessions.size === 0 && entry.rootProjects.size === 0) ||
				entry.queued
			)
				continue;
			const currentTier = tier(entry, now);
			const interval = intervals[currentTier];
			if (
				entry.forced ||
				(!entry.published && entry.hinted) ||
				(entry.hinted &&
					now - entry.lastHintRead >= hintThrottleMs &&
					(currentTier === "viewed" ||
						interval === Number.POSITIVE_INFINITY ||
						now - entry.lastRead >= interval)) ||
				((currentTier === "running" || currentTier === "viewed") &&
					now - entry.lastRead >= interval)
			) {
				if (entry.hinted && !entry.forced) entry.lastHintRead = now;
				yield* enqueue(entry);
			} else if (
				currentTier === "listed" &&
				now - entry.lastRead >= interval &&
				entry.lastRead < (safetyNet?.lastRead ?? Number.POSITIVE_INFINITY)
			)
				safetyNet = entry;
		}
		if (safetyNet && now - lastSafetyNet >= safetyNetGapMs) {
			lastSafetyNet = now;
			yield* enqueue(safetyNet);
		}
	});
	// Delay initial scheduling: startup never launches an unbounded refresh fanout.
	yield* Effect.forever(Effect.sleep(100).pipe(Effect.andThen(schedule))).pipe(
		Effect.forkScoped,
	);
	// One daemon-wide loop bounds filesystem work, including shared git dirs.
	// Releasing an entry interrupts its probe without waiting for a native stat.
	yield* Effect.forever(
		Effect.sleep(100).pipe(
			Effect.andThen(
				Effect.gen(function* () {
					for (const entry of directories.values()) {
						const now = yield* Clock.currentTimeMillis;
						if (
							entry.projects.size === 0 ||
							entry.abort.signal.aborted ||
							now - entry.lastProbe < probeIntervals[tier(entry, now)]
						)
							continue;
						entry.lastProbe = now;
						yield* probe(entry);
					}
				}),
			),
		),
	).pipe(Effect.forkScoped);
	if (Option.isSome(events)) {
		const stream = yield* events.value.subscribe();
		yield* stream.pipe(
			Stream.filter(
				(event) =>
					event.runEnded === true ||
					event.type === "session.created" ||
					event.type === "session.workspace_changed" ||
					event.type === "session.status" ||
					event.type === "session.deleted" ||
					event.type === "run.started" ||
					event.type === "run.requested" ||
					event.type === "turn.completed" ||
					event.type === "turn.interrupted" ||
					event.type === "turn.error",
			),
			Stream.runForEach((event) =>
				Effect.gen(function* () {
					if (event.type === "session.deleted")
						return yield* owners
							.close({ kind: "session", sessionId: event.sessionId }, "remove")
							.pipe(
								Effect.catch((error) =>
									Effect.logWarning("Session git owner close failed", error),
								),
							);
					const wasRunning = sessions.get(event.sessionId)?.running === true;
					const session = yield* attach(event.sessionId);
					if (!session) return;
					if (event.runEnded === true || (wasRunning && !session.running)) {
						session.running = false;
						for (const key of session.directories) {
							const entry = directories.get(key);
							if (entry) request(entry, true);
						}
					}
					if (event.type === "session.workspace_changed")
						for (const key of session.directories) {
							const entry = directories.get(key);
							if (entry) request(entry, true);
						}
				}),
			),
			Effect.forkScoped,
		);
	}
	if (Option.isSome(activity)) {
		const stream = yield* activity.value.subscribe;
		yield* stream.pipe(
			Stream.runForEach((id) => Effect.asVoid(attach(id))),
			Effect.forkScoped,
		);
	}
	// Cold projects participate too: all registered rows acquire only owner-held
	// state here; the worker queue and subprocess owner cap the subsequent reads.
	yield* Effect.gen(function* () {
		yield* Effect.sleep(100);
		const projects = [...HashMap.keys(yield* Ref.get(registry))];
		if (projects.length === 0) return;
		const rows = yield* sql<{
			id: string;
		}>`SELECT id FROM sessions WHERE project_id IN ${sql.in(projects)}`;
		for (const { id } of rows) {
			const session = yield* attach(id);
			if (session)
				for (const key of session.directories) {
					const entry = directories.get(key);
					if (entry && !Number.isFinite(entry.lastRead)) request(entry, true);
				}
		}
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning("Session git startup failed", error),
		),
		Effect.forkScoped,
	);

	return {
		read: (sessionId) =>
			Effect.gen(function* () {
				const readRequest = yield* ReadRequest;
				const now = yield* Clock.currentTimeMillis;
				if (readRequest !== undefined) {
					pendingReads.add(sessionId);
					if (readQuietUntil === 0) readQuietUntil = now + 250;
					if (/List|Shell/.test(readRequest))
						pendingListed.set(sessionId, now + 60_000);
					for (const key of sessions.get(sessionId)?.directories ?? []) {
						const entry = directories.get(key);
						if (entry) yield* checkPresence(entry);
					}
					return yield* readPublishedSessionGit(sessionId).pipe(
						Effect.provideService(SqlClient.SqlClient, sql),
						Effect.provideService(ProjectRegistryTag, registry),
					);
				}
				const session = yield* attach(sessionId);
				if (!session) return undefined;
				for (const key of session.directories) {
					const entry = directories.get(key);
					if (!entry) continue;
					yield* checkPresence(entry);
					if (!entry.published && readRequest === undefined) {
						request(entry, true);
						yield* enqueue(entry);
						yield* Deferred.await(entry.first);
					} else if (now - entry.lastRead >= intervals[tier(entry, now)])
						request(entry);
				}
				return yield* readPublishedSessionGit(sessionId).pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.provideService(ProjectRegistryTag, registry),
				);
			}).pipe(
				Effect.catch((error) =>
					Effect.logWarning("Published session git read failed", error).pipe(
						Effect.as(undefined),
					),
				),
			),
		changes: Stream.fromPubSub(changes),
		invalidate: (target) =>
			Effect.gen(function* () {
				if ("directory" in target) {
					const key = canonicalDirectory(target.directory);
					const marker = yield* ReadRequest;
					const listedUntil =
						marker === "GetProjects"
							? (yield* Clock.currentTimeMillis) + 60_000
							: 0;
					if (listedUntil > 0 && readQuietUntil === 0)
						readQuietUntil = listedUntil - 60_000 + 250;
					const pending = pendingDirectories.get(key);
					pendingDirectories.set(key, {
						listedUntil: Math.max(pending?.listedUntil ?? 0, listedUntil),
						invalidated: pending?.invalidated === true || listedUntil === 0,
					});
					return;
				}
				pendingSessions.add(target.sessionId);
			}),
	} satisfies Context.Service.Shape<typeof SessionGit>;
});
