import { Context, type Effect, Layer, type Stream } from "effect";
import type {
	SessionDiffError,
	SessionDiffListing,
	SessionDiffScope,
} from "../../../contracts/session-diff.js";
import { makeSessionDiff } from "../Layers/session-diff-layer.js";
import { FolderTimelineLive } from "./folder-timeline.js";

/** An Effective Folder that already passed the workspace guard. */
export interface SessionDiffFolder {
	readonly root: string;
	readonly directory: string;
	readonly present: boolean;
	/** The commit the session's worktree launched from, if it owns one. */
	readonly launchBase?: string;
}

export interface SessionDiffSession {
	readonly id: string;
	readonly folders: readonly SessionDiffFolder[];
}

/**
 * Read-only per-file diffs for a session. It keeps no state of record: a
 * bounded memo of recent listings proves that file() serves listed pairs and
 * answers a list pinned to a pushed revision without another snapshot.
 */
export class SessionDiff extends Context.Service<
	SessionDiff,
	{
		/** A remembered `revision` is answered from the memo; otherwise it snapshots. */
		readonly list: (
			session: SessionDiffSession,
			scope: SessionDiffScope,
			revision?: string,
		) => Effect.Effect<SessionDiffListing>;
		/**
		 * Each new revision of a live scope, re-listed once per SessionGit change
		 * to one of the session's folders and shared by every subscriber. Nothing
		 * snapshots while no one subscribes.
		 */
		readonly changes: (
			session: SessionDiffSession,
			scope: SessionDiffScope,
		) => Stream.Stream<string>;
		readonly file: (request: {
			readonly sessionId: string;
			readonly scope: SessionDiffScope;
			readonly revision: string;
			readonly folder: string;
			readonly path: string;
			readonly before: string | null;
			readonly after: string | null;
		}) => Effect.Effect<{ readonly patch: string }, SessionDiffError>;
	}
>()("SessionDiff") {}

export const SessionDiffLive = (configDir: string) =>
	Layer.effect(SessionDiff, makeSessionDiff).pipe(
		Layer.provideMerge(FolderTimelineLive(configDir)),
	);
