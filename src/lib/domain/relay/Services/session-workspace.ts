import { Context, type Effect } from "effect";
import type {
	SessionWorkspace as RecordedWorkspace,
	WorkspaceMoveCause,
	WorkspaceMoveError,
} from "../../../contracts/session-workspace.js";
import type {
	ApplySessionCommandOptions,
	SessionCommandError,
} from "./session-command.js";

export interface SessionWorkspace {
	/** Serialize launch-folder reads with draft workspace initialization. */
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
	) => Effect.Effect<string, WorkspaceMoveError | SessionCommandError>;
	/** Resolve and warm a target before acquiring a project commit permit. */
	readonly resolve: (
		sessionId: string,
		path: string,
		cause: WorkspaceMoveCause,
		origin?: RecordedWorkspace["origin"],
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
}

export class SessionWorkspaceTag extends Context.Tag("SessionWorkspace")<
	SessionWorkspaceTag,
	SessionWorkspace
>() {}
