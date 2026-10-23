import { lstat } from "node:fs/promises";
import { join, sep } from "node:path";
import { Context, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { Account } from "../../../contracts/account.js";
import {
	type SessionWorkspace as RecordedWorkspace,
	SessionWorkspaceSchema,
	type SessionWorktreeOwnership,
	type WorkspaceMoveCause,
	type WorkspaceMoveError,
} from "../../../contracts/session-workspace.js";
import {
	type WorkspaceMissing,
	type WorktreeBranchRenameError,
	WorktreeRecoveryError,
} from "../../../contracts/worktree.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { readPublishedWorkspaceMissing } from "../../../persistence/effect/session-git-publication.js";
import { labelProjectFolders } from "../../../project-folders.js";
import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
import type { SessionInfo } from "../../../shared-types.js";
import {
	OpenCodeInstancesTag,
	OpenCodeUnavailable,
} from "../../daemon/Services/opencode-instances-service.js";
import { SessionGit } from "../../daemon/Services/session-git.js";
import { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import { ConfigTag } from "./services.js";
import type {
	ApplySessionCommandOptions,
	SessionCommandError,
} from "./session-command.js";
import { readSessionWorktreeOwnership } from "./session-worktree-deletion.js";

export interface SessionWorkspace {
	/** Resolve an existing workspace before a draft has a persisted session. */
	readonly preview: (
		account: Account,
		path: string,
		/** Required for daemon-owned previews before a session exists. */
		projectId?: string,
	) => Effect.Effect<
		RecordedWorkspace,
		WorkspaceMoveError | SessionCommandError
	>;
	readonly renameBranch: (
		sessionId: string,
		branchName: string,
	) => Effect.Effect<void, WorktreeBranchRenameError | SessionCommandError>;
	/** Serialize one session's launch-folder reads and workspace initialization in the caller's project. Not reentrant. */
	readonly withLaunch: <A, E, R>(
		sessionId: string,
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
	/** Exclude all session work for shared checkout cleanup or project-wide batches. Never nest with withLaunch. */
	readonly withProjectLaunch: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
	/** Daemon registration removal retires its cached launch permit. */
	readonly forgetProject?: (projectId: string) => void;
	readonly get: (
		sessionId: string,
		/** Native directory before the session declares a stored workspace. */
		nativeDirectory?: string,
		/** Legacy hint; the service resolves the session's owning project. */
		mainFolder?: string,
	) => Effect.Effect<string, SessionCommandError>;
	readonly move: (
		sessionId: string,
		path: string,
		cause: WorkspaceMoveCause,
		origin?: RecordedWorkspace["origin"],
		projectFolder?: string,
		ownership?: readonly SessionWorktreeOwnership[],
	) => Effect.Effect<string, WorkspaceMoveError | SessionCommandError>;
	/** Copy a parent's recorded mapping and origin into a fork's launch event. */
	readonly inherit: (
		sessionId: string,
		parentSessionId: string,
		options?: Pick<ApplySessionCommandOptions, "project">,
	) => Effect.Effect<string, SessionCommandError>;
	/** Resolve and warm a target; projectFolder disambiguates folders sharing a checkout. */
	readonly resolve: (
		sessionId: string,
		path: string,
		cause: WorkspaceMoveCause,
		origin?: RecordedWorkspace["origin"],
		projectFolder?: string,
	) => Effect.Effect<
		ResolvedWorkspaceTarget,
		WorkspaceMoveError | SessionCommandError
	>;
	/** Re-read and record through the commit seam, optionally joining a caller's commit. */
	readonly record: (
		sessionId: string,
		target: ResolvedWorkspaceTarget,
		cause: WorkspaceMoveCause,
		options?: Pick<ApplySessionCommandOptions, "project">,
	) => Effect.Effect<string, WorkspaceMoveError | SessionCommandError>;
	/** A user move is pending until a matching startup or agent declaration acknowledges it. */
	readonly claudeWorktreeState: (sessionId: string) => Effect.Effect<
		{
			readonly enteredWorktree: boolean;
			readonly pendingUserMove: boolean;
			readonly directivePending: boolean;
			readonly userMoveSequence: number | undefined;
			readonly requestedPath: string;
			readonly workspaceMismatch: { readonly actualPath: string } | undefined;
		},
		SessionCommandError
	>;
}

export interface ResolvedWorkspaceTarget {
	readonly path: string;
	readonly projectFolder: string;
	readonly reset: boolean;
	readonly provider: string;
	readonly origin?: RecordedWorkspace["origin"];
	readonly ownership?: readonly SessionWorktreeOwnership[];
}

export class SessionWorkspaceTag extends Context.Service<
	SessionWorkspaceTag,
	SessionWorkspace
>()("SessionWorkspace") {}

/** Passive reads never start an instance or extend its idle grace. */
export const makeSessionOpenCodeClient = Effect.gen(function* () {
	const workspace = yield* SessionWorkspaceTag;
	const read = yield* ReadQueryEffectTag;
	const instances = yield* OpenCodeInstancesTag;
	return (sessionId: string, instanceId?: string, directory?: string) =>
		Effect.gen(function* () {
			const target = yield* workspace.withLaunch(
				sessionId,
				Effect.gen(function* () {
					const row = yield* read.getSession(sessionId);
					const owner = instanceId ?? row?.provider;
					if (owner === undefined) return Option.none();
					return Option.some({
						instanceId: owner,
						directory:
							row === undefined
								? (directory ?? null)
								: yield* workspace.get(sessionId, directory),
					});
				}),
			);
			if (Option.isNone(target)) return Option.none();
			const client = yield* instances.ifRunning(
				target.value.instanceId,
				target.value.directory,
			);
			if (Option.isNone(client))
				return yield* new OpenCodeUnavailable({
					instanceId: target.value.instanceId,
					reason: "not-running",
					message: `OpenCode instance "${target.value.instanceId}" is not running`,
				});
			return client;
		});
});

// Snapshot-only callers have no event store; Git registration remains sufficient
// for them. Recovery uses only recorded ownership, never legacy branch inference.
const readRecordedWorktreeOwnership = (
	sessionId: string,
	projectSlug: string,
) =>
	Effect.gen(function* () {
		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		if (sql._tag === "None") return [];
		return yield* readSessionWorktreeOwnership(
			sessionId,
			false,
			projectSlug,
		).pipe(Effect.provideService(SqlClient.SqlClient, sql.value));
	});

// Several project folders can share one checkout and its single ownership row.
const recordedBranchForFolder = (
	ownership: readonly SessionWorktreeOwnership[],
	folder: string,
	directory: string,
) =>
	ownership.find(
		(owned) =>
			owned.folder === folder ||
			directory === owned.path ||
			directory.startsWith(`${owned.path}${sep}`),
	)?.branchName;

export const recreateSessionWorktrees = (sessionId: string) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const workspace = yield* SessionWorkspaceTag;
		const worktrees = yield* WorktreeServiceTag;
		const read = yield* ReadQueryEffectTag;
		const result = yield* workspace.withLaunch(
			sessionId,
			Effect.gen(function* () {
				const row = yield* read.getSession(sessionId);
				const state =
					row?.workspace == null
						? null
						: yield* Schema.decodeUnknownEffect(
								Schema.fromJsonString(SessionWorkspaceSchema),
							)(row.workspace);
				const directory = effectiveWorkingDirectory(config.projectDir, state);
				const folders =
					state?.origin === "conduit" ? Object.entries(state.worktrees) : [];
				if (folders.length === 0)
					return yield* new WorktreeRecoveryError({
						path: directory,
						reason: "not-owned",
						message:
							"Could not recreate worktree: the session has no Conduit-owned worktree.",
					});
				const ownership = yield* readRecordedWorktreeOwnership(
					sessionId,
					config.slug,
				);
				yield* worktrees.recreateAll(
					folders.map(([path, directory]) => {
						const recordedBranch = recordedBranchForFolder(
							ownership,
							path,
							directory,
						);
						return {
							folder: { path, projectSlug: config.slug, sessionId },
							directory,
							...(recordedBranch ? { recordedBranch } : {}),
						};
					}),
				);
				return { directory };
			}),
		);
		const git = yield* Effect.serviceOption(SessionGit);
		if (git._tag === "Some") yield* git.value.invalidate({ sessionId });
		return result;
	});

/** Enrich canonical workspace state with current filesystem/Git availability. */
export const inspectSessionWorktree = (
	session: Pick<SessionInfo, "id" | "workspace">,
	project: {
		readonly projectDir: string;
		readonly slug: string;
		readonly extraFolders?: readonly string[];
	},
): Effect.Effect<WorkspaceMissing | undefined> =>
	Effect.gen(function* () {
		if (session.workspace?.origin !== "conduit") return undefined;
		const entries = Object.entries(session.workspace.worktrees);
		const service = yield* Effect.serviceOption(WorktreeServiceTag);
		const ownership = yield* Effect.cached(
			readRecordedWorktreeOwnership(session.id, project.slug).pipe(
				Effect.orElseSucceed(() => []),
			),
		);
		const missing = (yield* Effect.forEach(entries, ([folder, directory]) =>
			Effect.gen(function* () {
				// List reads inspect every session. A real checkout with a `.git`
				// file needs no Git call; symlinks and unusable paths are inspected.
				const present = yield* Effect.tryPromise(
					async () =>
						(await lstat(directory)).isDirectory() &&
						(await lstat(join(directory, ".git"))).isFile(),
				).pipe(Effect.orElseSucceed(() => false));
				if (present) return [];
				const state: WorkspaceMissing | undefined =
					service._tag === "None"
						? { path: directory, canRecreate: false, reason: "git-failed" }
						: yield* service.value
								.inspectMissing(
									{
										path: folder,
										projectSlug: project.slug,
										sessionId: session.id,
									},
									directory,
									entries.map(([folder]) => folder),
									recordedBranchForFolder(yield* ownership, folder, directory),
								)
								.pipe(
									Effect.catch((error) =>
										Effect.succeed({
											path: directory,
											canRecreate: false,
											reason:
												error.reason === "not-owned"
													? ("not-owned" as const)
													: ("git-failed" as const),
										}),
									),
								);
				return state ? [{ folder, ...state }] : [];
			}),
		)).flat();
		const first = missing[0];
		if (!first) return undefined;
		const { folder: _folder, ...state } = first;
		const reason = missing.find((entry) => !entry.canRecreate)?.reason;
		return {
			...state,
			canRecreate: missing.every((entry) => entry.canRecreate),
			...(reason ? { reason } : {}),
			...(entries.length > 1 || project.extraFolders?.length
				? { folders: missing }
				: {}),
		};
	});

export const withSessionWorktreeStatus = (
	session: SessionInfo,
	project: {
		readonly projectDir: string;
		readonly slug: string;
		readonly extraFolders?: readonly string[];
	},
) =>
	Effect.gen(function* () {
		const workspaceMissing = yield* readPublishedWorkspaceMissing(session.id, [
			project.projectDir,
			...(project.extraFolders ?? []),
		]).pipe(Effect.orElseSucceed(() => undefined));
		// List reads run this per row: only a projected Conduit launch can own
		// branches, and forks inherit that workspace, so the event check is exact.
		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		const launched =
			session.workspace?.origin === "conduit" &&
			Object.keys(session.workspace.worktrees).length > 0;
		const canRenameBranch =
			launched && sql._tag === "Some"
				? yield* sql.value<{ owned: number }>`
		SELECT EXISTS(SELECT 1 FROM events WHERE session_id = ${session.id}
			AND type = 'session.workspace_changed' AND json_extract(data, '$.cause') = 'launch'
			AND json_extract(data, '$.origin') = 'conduit'
			AND json_array_length(data, '$.ownership') > 0) AS owned`.pipe(
						Effect.map((rows) => rows[0]?.owned === 1),
						Effect.orElseSucceed(() => false),
					)
				: false;
		const base = { ...session, workspaceMissing, canRenameBranch };
		if (!workspaceMissing) return base satisfies SessionInfo;
		if (!workspaceMissing.folders)
			return { ...base, git: undefined } satisfies SessionInfo;
		const roots = [
			...new Set([
				project.projectDir,
				...(project.extraFolders ?? []),
				...Object.keys(session.workspace?.worktrees ?? {}),
			]),
		];
		const folders = labelProjectFolders(roots).flatMap(({ root, label }) => {
			if (workspaceMissing.folders?.some(({ folder }) => folder === root))
				return [{ root, label, missing: true }];
			const status = session.git?.folders?.find(
				(folder) => folder.root === root,
			);
			return status ? [status] : [];
		});
		const { folders: _folders, ...primary } = session.git ?? {};
		const primaryMissing = workspaceMissing.folders.some(
			({ path }) =>
				path ===
				effectiveWorkingDirectory(project.projectDir, session.workspace),
		);
		return {
			...base,
			git: { ...(!primaryMissing ? primary : {}), folders },
		} satisfies SessionInfo;
	});
