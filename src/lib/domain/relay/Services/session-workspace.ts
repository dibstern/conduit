import { Context, type Effect } from "effect";
import type {
	WorkspaceMoveCause,
	WorkspaceMoveError,
} from "../../../contracts/session-workspace.js";
import type { SessionCommandError } from "./session-command.js";

export interface SessionWorkspace {
	readonly get: (
		sessionId: string,
	) => Effect.Effect<string, SessionCommandError>;
	readonly move: (
		sessionId: string,
		path: string,
		cause: WorkspaceMoveCause,
	) => Effect.Effect<string, WorkspaceMoveError | SessionCommandError>;
}

export class SessionWorkspaceTag extends Context.Tag("SessionWorkspace")<
	SessionWorkspaceTag,
	SessionWorkspace
>() {}
