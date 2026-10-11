import { lstatSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect } from "effect";
import type {
	SessionWorkspace as RecordedWorkspace,
	SessionWorktreeOwnership,
	WorkspaceMoveCause,
	WorkspaceMoveError,
} from "../../../contracts/session-workspace.js";
import type { WorkspaceMissing } from "../../../contracts/worktree.js";
import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
import type { SessionInfo } from "../../../shared-types.js";
import { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import type {
	ApplySessionCommandOptions,
	SessionCommandError,
} from "./session-command.js";

export interface SessionWorkspace {
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
	project: { readonly projectDir: string; readonly slug: string },
): Effect.Effect<WorkspaceMissing | undefined> =>
	Effect.gen(function* () {
		if (session.workspace?.origin !== "conduit") return undefined;
		const directory = effectiveWorkingDirectory(
			project.projectDir,
			session.workspace,
		);
		const folder = Object.entries(session.workspace.worktrees).find(
			([, path]) => path === directory,
		)?.[0];
		if (!folder) return undefined;
		// List reads inspect every session, so a present checkout (a real directory
		// with a worktree's `.git` file) skips Git; anything else is inspected.
		const present =
			lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() &&
			lstatSync(join(directory, ".git"), { throwIfNoEntry: false })?.isFile();
		if (present) return undefined;
		const service = yield* Effect.serviceOption(WorktreeServiceTag);
		if (service._tag === "None")
			return {
				path: directory,
				canRecreate: false,
				reason: "git-failed" as const,
			};
		return yield* service.value
			.inspectMissing(
				{
					path: folder,
					projectSlug: project.slug,
					sessionId: session.id,
				},
				directory,
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
	});

export const withSessionWorktreeStatus = (
	session: SessionInfo,
	project: { readonly projectDir: string; readonly slug: string },
) =>
	inspectSessionWorktree(session, project).pipe(
		Effect.map(
			(workspaceMissing): SessionInfo => ({
				...session,
				workspaceMissing,
				...(workspaceMissing ? { git: undefined } : {}),
			}),
		),
	);
