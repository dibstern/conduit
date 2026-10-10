import { Context, type Effect } from "effect";
import type {
	WorkspaceMoveCause,
	WorkspaceMoveError,
} from "../../../contracts/session-workspace.js";
import type {
	ApplySessionCommandOptions,
	SessionCommandError,
} from "./session-command.js";

export interface SessionWorkspace {
	readonly get: (
		sessionId: string,
	) => Effect.Effect<string, SessionCommandError>;
	readonly move: (
		sessionId: string,
		path: string,
		cause: WorkspaceMoveCause,
		options?: Pick<ApplySessionCommandOptions, "project">,
	) => Effect.Effect<string, WorkspaceMoveError | SessionCommandError>;
	/** Derived from canonical tool declarations and subsequent cwd acknowledgments. */
	readonly claudeWorktreeState: (sessionId: string) => Effect.Effect<
		{
			readonly enteredWorktree: boolean;
			readonly pendingUserMove: boolean;
		},
		SessionCommandError
	>;
}

export class SessionWorkspaceTag extends Context.Tag("SessionWorkspace")<
	SessionWorkspaceTag,
	SessionWorkspace
>() {}
