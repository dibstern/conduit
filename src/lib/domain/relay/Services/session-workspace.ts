import { Context, type Effect } from "effect";
import type {
	WorkspaceMoveCause,
	WorkspaceMoveError,
} from "../../../contracts/session-workspace.js";
import type { SessionCommandError } from "./session-command.js";

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
	) => Effect.Effect<string, WorkspaceMoveError | SessionCommandError>;
}

export class SessionWorkspaceTag extends Context.Tag("SessionWorkspace")<
	SessionWorkspaceTag,
	SessionWorkspace
>() {}
