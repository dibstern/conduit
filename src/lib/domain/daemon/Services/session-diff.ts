import { Context, type Effect, Layer } from "effect";
import type {
	SessionDiffError,
	SessionDiffListing,
	SessionDiffPatch,
	SessionDiffScope,
} from "../../../contracts/session-diff.js";
import { makeSessionDiff } from "../Layers/session-diff-layer.js";
import { FolderTimelineLive } from "./folder-timeline.js";

/** An Effective Folder that already passed the workspace guard. */
export interface SessionDiffFolder {
	readonly root: string;
	readonly directory: string;
	readonly present: boolean;
}

/**
 * Read-only per-file diffs for a session. It keeps no state of record: a
 * bounded memo of recent listings only proves that file() serves listed pairs.
 */
export class SessionDiff extends Context.Service<
	SessionDiff,
	{
		readonly list: (
			session: {
				readonly id: string;
				readonly folders: readonly SessionDiffFolder[];
			},
			scope: SessionDiffScope,
		) => Effect.Effect<SessionDiffListing>;
		readonly file: (request: {
			readonly sessionId: string;
			readonly scope: SessionDiffScope;
			readonly revision: string;
			readonly folder: string;
			readonly path: string;
			readonly before: string | null;
			readonly after: string | null;
		}) => Effect.Effect<SessionDiffPatch, SessionDiffError>;
	}
>()("SessionDiff") {}

export const SessionDiffLive = (configDir: string) =>
	Layer.effect(SessionDiff, makeSessionDiff).pipe(
		Layer.provideMerge(FolderTimelineLive(configDir)),
	);
