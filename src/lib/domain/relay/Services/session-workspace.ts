import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Context, Effect } from "effect";
import type {
	SessionWorkspace as RecordedWorkspace,
	SessionWorktreeOwnership,
	WorkspaceMoveCause,
	WorkspaceMoveError,
} from "../../../contracts/session-workspace.js";
import type {
	WorkspaceMissing,
	WorktreeBranchRenameError,
} from "../../../contracts/worktree.js";
import { labelProjectFolders } from "../../../project-folders.js";
import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
import type { SessionInfo } from "../../../shared-types.js";
import { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import type {
	ApplySessionCommandOptions,
	SessionCommandError,
} from "./session-command.js";

export interface SessionWorkspace {
	readonly renameBranch: (
		sessionId: string,
		branchName: string,
	) => Effect.Effect<void, WorktreeBranchRenameError | SessionCommandError>;
	/** Serialize launch-folder reads with draft and fork workspace initialization. */
	readonly withLaunch: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
	readonly get: (
		sessionId: string,
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
	/** Re-read and record through the command seam, optionally joining a caller's commit. */
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

export class SessionWorkspaceTag extends Context.Tag("SessionWorkspace")<
	SessionWorkspaceTag,
	SessionWorkspace
>() {}

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
								)
								.pipe(
									Effect.catchAll((error) =>
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
		const workspaceMissing = yield* inspectSessionWorktree(session, project);
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
