import { relative, resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Effect, Layer, Result, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import type { Account } from "../../../contracts/account.js";
import {
	isKnownDriverKind,
	PROVIDER_DRIVERS,
} from "../../../contracts/provider-instance.js";
import {
	type SessionWorkspace as RecordedWorkspace,
	SessionWorkspaceSchema,
	WorkspaceMoveError,
} from "../../../contracts/session-workspace.js";
import { WorktreeBranchRenameError } from "../../../contracts/worktree.js";
import * as Failure from "../../../effect/failure-classification.js";
import { daemonSessionGitCache } from "../../../git/session-git.js";
import { readWorktrees, realWorkspacePath } from "../../../git/worktrees.js";
import {
	type CommitAndSignalProject,
	makeUnboundCommitAndSignal,
} from "../../../persistence/effect/commit-and-signal.js";
import {
	makeUnboundEventStoreEffect,
	UnboundEventStoreEffectTag,
} from "../../../persistence/effect/event-store-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import {
	canonicalEvent,
	type EventPayloadMap,
} from "../../../persistence/events.js";
import { readClaudeWorktreeState } from "../../../session/claude-worktree-state.js";
import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { ProjectContext } from "../../daemon/Services/project-context.js";
import { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import { ConfigTag } from "../Services/services.js";
import { SessionCommandError } from "../Services/session-command.js";
import {
	type ResolvedWorkspaceTarget,
	type SessionWorkspace,
	SessionWorkspaceTag,
} from "../Services/session-workspace.js";
import { readSessionWorktreeOwnership } from "../Services/session-worktree-deletion.js";

export const SessionWorkspaceLive = Layer.effect(
	SessionWorkspaceTag,
	Effect.gen(function* () {
		const accounts = yield* AccountDirectory;
		const projects = yield* Effect.serviceOption(ProjectContext);
		const config = yield* Effect.serviceOption(ConfigTag);
		const read = yield* ReadQueryEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const store = yield* makeUnboundEventStoreEffect;
		const commitAndSignal = yield* makeUnboundCommitAndSignal.pipe(
			Effect.provideService(UnboundEventStoreEffectTag, store),
		);
		const worktreeService = yield* Effect.serviceOption(WorktreeServiceTag);
		const ownershipServices = yield* Effect.context<SqlClient.SqlClient>();
		// Each project has one launch semaphore. A session operation takes one
		// permit, so sessions run in parallel; project-wide work takes them all.
		// Keep this finite: Infinity - Infinity would break semaphore accounting.
		const projectPermits = Number.MAX_SAFE_INTEGER;
		interface ProjectLaunches {
			readonly project: Semaphore.Semaphore;
			readonly sessions: Map<
				string,
				{ readonly lock: Semaphore.Semaphore; users: number }
			>;
		}
		const makeLaunches = (): ProjectLaunches => ({
			project: Semaphore.makeUnsafe(projectPermits),
			sessions: new Map(),
		});
		const launches = new Map<string, ProjectLaunches>();
		const standaloneLaunches = makeLaunches();
		const launchesFor = (projectId?: string) => {
			if (!projectId) return standaloneLaunches;
			let entry = launches.get(projectId);
			if (!entry) {
				entry = makeLaunches();
				launches.set(projectId, entry);
			}
			return entry;
		};
		const callerProject = Effect.map(
			Effect.serviceOption(ConfigTag),
			(caller) =>
				caller._tag === "Some"
					? caller.value.slug
					: config._tag === "Some"
						? config.value.slug
						: undefined,
		);
		const withSessionLaunch = <A, E, R>(
			sessionId: string,
			effect: Effect.Effect<A, E, R>,
			projectId?: string,
		): Effect.Effect<A, E, R> =>
			Effect.suspend(() => {
				const { project, sessions } = launchesFor(projectId);
				return Effect.acquireUseRelease(
					Effect.sync(() => {
						let entry = sessions.get(sessionId);
						if (!entry) {
							entry = { lock: Semaphore.makeUnsafe(1), users: 0 };
							sessions.set(sessionId, entry);
						}
						// Count waiters too, including those waiting for the project permit.
						entry.users++;
						return entry;
					}),
					(entry) => project.withPermits(1)(entry.lock.withPermits(1)(effect)),
					(entry) =>
						Effect.sync(() => {
							if (--entry.users === 0) sessions.delete(sessionId);
						}),
				);
			});
		const projectFor = (session: string | Account, projectId?: string) =>
			Effect.gen(function* () {
				if (projects._tag === "Some") {
					if (typeof session === "string")
						return yield* projects.value.forSession(session);
					if (projectId !== undefined)
						return yield* projects.value.forProject(projectId);
					return yield* new SessionCommandError({
						operation: "workspace.project",
						cause: "A draft workspace requires a project id",
					});
				}
				if (config._tag === "Some")
					return {
						projectId: config.value.slug,
						mainFolder: config.value.projectDir,
						extraFolders: config.value.extraFolders ?? [],
					};
				return yield* new SessionCommandError({
					operation: "workspace.project",
					cause: "Workspace project context is unavailable",
				});
			}).pipe(
				Effect.mapError((cause) =>
					cause instanceof SessionCommandError
						? cause
						: new SessionCommandError({
								operation: "workspace.project",
								cause,
							}),
				),
			);
		const readWorkspace = (sessionId: string) =>
			Effect.gen(function* () {
				const row = yield* read
					.getSession(sessionId)
					.pipe(
						Effect.mapError(
							(cause) =>
								new SessionCommandError({ operation: "workspace.get", cause }),
						),
					);
				if (!row)
					return yield* new SessionCommandError({
						operation: "workspace.get",
						cause: `Session ${sessionId} not found`,
					});
				const workspace =
					row.workspace == null
						? null
						: yield* Schema.decodeUnknownEffect(
								Schema.fromJsonString(SessionWorkspaceSchema),
							)(row.workspace).pipe(
								Effect.mapError(
									(cause) =>
										new SessionCommandError({
											operation: "workspace.get",
											cause,
										}),
								),
							);
				return { row, workspace, project: yield* projectFor(sessionId) };
			});
		// Workspace changes have no upstream sync. Use the same append/project/
		// signal transaction for daemon writes and callers joining an existing commit.
		const writeWorkspace = (
			data: EventPayloadMap["session.workspace_changed"],
			project?: CommitAndSignalProject,
		) =>
			Effect.gen(function* () {
				const { row } = yield* readWorkspace(data.sessionId);
				const events = [
					canonicalEvent("session.workspace_changed", data.sessionId, data, {
						provider: row.provider,
						createdAt: Date.now(),
						metadata: { source: "relay" },
					}),
				];
				yield* project
					? Effect.flatMap(store.appendBatch(events), project)
					: commitAndSignal(events);
			});
		const latestMove = (sessionId: string) => sql<{
			sequence: number;
			cause: string;
		}>`
			SELECT sequence, json_extract(data, '$.cause') AS cause FROM events
			WHERE session_id = ${sessionId} AND type = 'session.workspace_changed'
			AND json_extract(data, '$.cause') != 'branch-rename'
			ORDER BY sequence DESC LIMIT 1`;
		const worktreesFor = (
			target: ResolvedWorkspaceTarget,
			previous: RecordedWorkspace | null,
			cause: RecordedWorkspace["cause"],
			mainFolder: string,
		): Record<string, string> => {
			if (!target.reset)
				return {
					...(target.origin === "conduit" && cause === "launch"
						? previous?.worktrees
						: {}),
					[target.projectFolder]: target.path,
				};
			const worktrees =
				target.projectFolder === mainFolder ? {} : { ...previous?.worktrees };
			delete worktrees[target.projectFolder];
			return worktrees;
		};
		const resolve = (
			sessionId: string | Account,
			path: string,
			cause: RecordedWorkspace["cause"],
			origin: RecordedWorkspace["origin"] = "existing",
			requestedFolder?: string,
			projectId?: string,
		) =>
			Effect.gen(function* () {
				const {
					row,
					workspace: previous,
					project,
				} = typeof sessionId === "string"
					? yield* readWorkspace(sessionId)
					: {
							row: { provider: sessionId.id, workspace_hint: null },
							workspace: null,
							project: yield* projectFor(sessionId, projectId),
						};
				const { mainFolder } = project;
				const folders = [mainFolder, ...project.extraFolders];
				const account =
					typeof sessionId !== "string"
						? sessionId
						: yield* accounts.resolve({ _tag: "Id", id: row.provider }).pipe(
								Effect.mapError(
									(cause) =>
										new SessionCommandError({
											operation: "workspace.resolve",
											cause,
										}),
								),
							);
				const driver = account.driver;
				if (
					!driver ||
					!isKnownDriverKind(driver) ||
					(!PROVIDER_DRIVERS[driver].sessionCapabilities.supportsWorktree &&
						!(
							(PROVIDER_DRIVERS[driver].sessionCapabilities
								.supportsNewWorktree &&
								cause === "launch" &&
								origin === "conduit") ||
							// OpenCode declarations acknowledge an already observed workspace.
							(PROVIDER_DRIVERS[driver].worktreeMoves ===
								"server-declaration" &&
								(cause === "agent" ||
									(cause === "missing" &&
										path === mainFolder &&
										previous?.origin === "existing" &&
										effectiveWorkingDirectory(mainFolder, previous) !==
											mainFolder) ||
									(cause === "user" &&
										(row.workspace_hint === path ||
											// Recovery of an owned launch stays in its original repository.
											(previous?.origin === "conduit" &&
												path === mainFolder)))))
						))
				)
					return yield* new WorkspaceMoveError({
						path,
						reason: "unsupported-provider",
					});
				const normalized = yield* realWorkspacePath(path);
				const candidates =
					requestedFolder === undefined
						? folders
						: folders.filter((folder) => folder === requestedFolder);
				let projectFolder: string | undefined;
				let configured = false;
				for (const folder of candidates) {
					const main = yield* realWorkspacePath(folder).pipe(Effect.option);
					if (main._tag === "Some" && main.value === normalized) {
						projectFolder = folder;
						configured = true;
						break;
					}
				}
				if (!configured) {
					const repo = yield* readWorktrees(normalized);
					if (
						!repo.worktrees.some(
							({ path }) =>
								path === normalized ||
								(origin === "conduit" &&
									cause === "launch" &&
									path === repo.root),
						)
					)
						return yield* new WorkspaceMoveError({
							path,
							reason: "not-a-worktree",
						});
					for (const folder of candidates) {
						const owner = yield* readWorktrees(folder).pipe(Effect.option);
						if (
							owner._tag === "Some" &&
							owner.value.commonDir === repo.commonDir &&
							(origin !== "conduit" ||
								normalized ===
									resolvePath(repo.root, relative(owner.value.root, folder)))
						) {
							projectFolder = folder;
							break;
						}
					}
				}
				if (projectFolder === undefined)
					return yield* new WorkspaceMoveError({
						path,
						reason: "other-repository",
					});
				// A draft choosing a secondary checkout starts there; a later move back
				// to a configured folder still resets its mapping.
				const reset =
					configured && !(cause === "launch" && projectFolder !== mainFolder);
				const target = {
					path: normalized,
					projectFolder,
					reset,
					provider: row.provider,
					origin,
				};
				const workspace = {
					cause,
					worktrees: worktreesFor(target, previous, cause, mainFolder),
					origin,
				};
				// Warm outside the permit, using the key read-model consumers use.
				yield* Effect.tryPromise(() =>
					Promise.all([
						daemonSessionGitCache.refresh(normalized),
						daemonSessionGitCache.refresh(
							effectiveWorkingDirectory(mainFolder, workspace),
						),
					]),
				).pipe(
					Effect.mapError(
						(cause) =>
							new SessionCommandError({ operation: "workspace.git", cause }),
					),
				);
				return target;
			});
		const record: SessionWorkspace["record"] = (
			sessionId,
			target,
			cause,
			options,
		) => {
			const append = (project: CommitAndSignalProject) =>
				Effect.gen(function* () {
					const {
						row,
						workspace: previous,
						project: { mainFolder },
					} = yield* readWorkspace(sessionId);
					// A provider switch during resolution must not bypass capability validation.
					if (row.provider !== target.provider)
						return yield* new WorkspaceMoveError({
							path: target.path,
							reason: "unsupported-provider",
						});
					const worktrees = worktreesFor(target, previous, cause, mainFolder);
					if (
						(!target.reset &&
							!(target.origin === "conduit" && cause === "launch") &&
							effectiveWorkingDirectory(mainFolder, previous) ===
								target.path) ||
						isDeepStrictEqual(worktrees, previous?.worktrees ?? {})
					) {
						// A successful declaration can acknowledge a user or missing move,
						// including a reset whose read-model workspace is NULL.
						const latestCause =
							cause === "agent"
								? (yield* latestMove(sessionId))[0]?.cause
								: undefined;
						if (
							latestCause !== "user" &&
							latestCause !== "missing" &&
							!(
								cause === "user" &&
								(yield* readClaudeWorktreeState(sql, sessionId, mainFolder))
									.workspaceMismatch
							)
						)
							return target.path;
					}
					const directory = effectiveWorkingDirectory(mainFolder, {
						cause,
						worktrees,
						origin: target.origin ?? "existing",
					});
					const path = yield* realWorkspacePath(directory).pipe(
						Effect.orElseSucceed(() => directory),
					);
					yield* writeWorkspace(
						{
							sessionId,
							cause,
							path,
							worktrees,
							origin: target.origin ?? "existing",
							...(cause === "launch" &&
							target.origin === "conduit" &&
							target.ownership
								? { ownership: target.ownership }
								: {}),
						},
						project,
					);
					return target.path;
				});
			return (
				options?.project
					? append(options.project)
					: commitAndSignal.write(append)
			).pipe(
				Effect.mapError((error) =>
					error instanceof WorkspaceMoveError ||
					error instanceof SessionCommandError
						? error
						: new SessionCommandError({
								operation: "workspace.record",
								cause: error,
							}),
				),
			);
		};
		const inherit: SessionWorkspace["inherit"] = (
			sessionId,
			parentSessionId,
			options,
		) => {
			const append = (project: CommitAndSignalProject) =>
				Effect.gen(function* () {
					const {
						workspace,
						project: { mainFolder },
					} = yield* readWorkspace(parentSessionId);
					const path = effectiveWorkingDirectory(mainFolder, workspace);
					yield* writeWorkspace(
						{
							sessionId,
							path,
							cause: "launch",
							worktrees: { ...workspace?.worktrees },
							origin: workspace?.origin ?? "existing",
						},
						project,
					);
					return path;
				});
			return (
				options?.project
					? append(options.project)
					: commitAndSignal.write(append)
			).pipe(
				Effect.mapError((cause) =>
					cause instanceof SessionCommandError
						? cause
						: new SessionCommandError({
								operation: "workspace.inherit",
								cause,
							}),
				),
			);
		};
		return {
			withLaunch: (sessionId, effect) =>
				Effect.flatMap(callerProject, (projectId) =>
					withSessionLaunch(sessionId, effect, projectId),
				),
			withProjectLaunch: (effect) =>
				Effect.flatMap(callerProject, (projectId) =>
					launchesFor(projectId).project.withPermits(projectPermits)(effect),
				),
			// Held and queued callers keep the old semaphores. Their completion must
			// never delete a replacement registration's semaphores for the same slug.
			forgetProject: (projectId) => {
				launches.delete(projectId);
			},
			renameBranch: (sessionId, branchName) =>
				Effect.flatMap(projectFor(sessionId), ({ projectId }) =>
					withSessionLaunch(
						sessionId,
						Effect.gen(function* () {
							const {
								workspace,
								project: { mainFolder },
							} = yield* readWorkspace(sessionId);
							const ownership = yield* readSessionWorktreeOwnership(
								sessionId,
								false,
							);
							if (ownership.length === 0)
								return yield* new WorktreeBranchRenameError({
									folder: mainFolder,
									reason: "not-owned",
									message: "This session has no Conduit launch ownership.",
								});
							const worktrees = worktreeService;
							if (worktrees._tag === "None")
								return yield* new SessionCommandError({
									operation: "workspace.renameBranch",
									cause: "Branch rename is unavailable.",
								});
							// Git and the canonical ownership update must finish together even if
							// the requesting browser disconnects while Git is running.
							yield* Effect.gen(function* () {
								yield* worktrees.value.renameBranch(ownership, branchName);
								if (ownership.every((owned) => owned.branchName === branchName))
									return;
								const renamed = ownership.map((owned) => ({
									...owned,
									branchName,
								}));
								yield* writeWorkspace({
									sessionId,
									cause: "branch-rename",
									worktrees: { ...workspace?.worktrees },
									origin: workspace?.origin ?? "existing",
									ownership: renamed,
								}).pipe(
									Effect.catchCause((cause) =>
										Effect.gen(function* () {
											// A post-COMMIT signal failure must not undo recorded ownership.
											const recorded = yield* Effect.result(
												readSessionWorktreeOwnership(sessionId, false),
											);
											if (Result.isFailure(recorded))
												return yield* new WorktreeBranchRenameError({
													folder: ownership[0]?.folder ?? mainFolder,
													reason: "git-failed",
													message: `Git renamed the branch to ${branchName}, but its recorded ownership could not be checked. ${Failure.renderCause(cause).slice(0, 2_000)}. ${String(recorded.failure.cause).slice(0, 2_000)}`,
												});
											if (
												recorded.success.length === renamed.length &&
												recorded.success.every(
													(owned) => owned.branchName === branchName,
												)
											)
												return yield* Effect.failCause(cause);
											const originalName = ownership[0]?.branchName;
											if (originalName !== undefined)
												yield* worktrees.value
													.renameBranch(renamed, originalName)
													.pipe(
														Effect.mapError(
															(error) =>
																new WorktreeBranchRenameError({
																	folder: error.folder,
																	reason: "git-failed",
																	message: `${Failure.renderCause(cause).slice(0, 2_000)}. Branch rollback failed: ${error.message}`,
																}),
														),
													);
											return yield* Effect.failCause(cause);
										}),
									),
								);
							}).pipe(Effect.uninterruptible);
						}).pipe(
							Effect.provide(ownershipServices),
							Effect.mapError((cause) =>
								cause instanceof WorktreeBranchRenameError ||
								cause instanceof SessionCommandError
									? cause
									: new SessionCommandError({
											operation: "workspace.renameBranch",
											cause,
										}),
							),
						),
						projectId,
					),
				),
			get: (sessionId, nativeDirectory) =>
				readWorkspace(sessionId).pipe(
					Effect.flatMap(({ workspace, project: { mainFolder } }) =>
						Effect.gen(function* () {
							// Native sessions retain their first observed directory until an
							// explicit workspace move, including a reset, overrides it.
							if (
								workspace === null &&
								(yield* latestMove(sessionId)).length === 0
							) {
								if (nativeDirectory !== undefined) return nativeDirectory;
								const [native] = yield* sql<{ directory: string | null }>`
									SELECT json_extract(metadata, '$.nativeDirectory') AS directory FROM events
									WHERE session_id = ${sessionId} AND type = 'session.created'
									AND json_type(metadata, '$.nativeDirectory') = 'text'
									ORDER BY sequence DESC LIMIT 1`;
								if (native?.directory) return native.directory;
							}
							return effectiveWorkingDirectory(mainFolder, workspace);
						}).pipe(
							Effect.mapError(
								(cause) =>
									new SessionCommandError({
										operation: "workspace.get",
										cause,
									}),
							),
						),
					),
				),
			resolve,
			preview: (account, path, projectId) =>
				Effect.map(
					resolve(account, path, "launch", "existing", undefined, projectId),
					(target) => ({
						cause: "launch" as const,
						origin: target.origin,
						worktrees: target.reset
							? {}
							: { [target.projectFolder]: target.path },
					}),
				),
			record,
			inherit,
			move: (sessionId, path, cause, origin, projectFolder, ownership) =>
				resolve(sessionId, path, cause, origin, projectFolder).pipe(
					Effect.flatMap((target) =>
						record(
							sessionId,
							{ ...target, ...(ownership ? { ownership } : {}) },
							cause,
						),
					),
				),
			claudeWorktreeState: (sessionId) =>
				Effect.flatMap(projectFor(sessionId), ({ mainFolder }) =>
					readClaudeWorktreeState(sql, sessionId, mainFolder),
				).pipe(
					Effect.mapError(
						(cause) =>
							new SessionCommandError({
								operation: "workspace.claudeWorktreeState",
								cause,
							}),
					),
				),
		} satisfies SessionWorkspace;
	}),
);
