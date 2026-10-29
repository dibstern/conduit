import { Context, type Effect, Layer } from "effect";
import type {
	SessionDiffEdit,
	SessionDiffEditError,
} from "../../../contracts/session-diff.js";
import { makeWorkingTreeEdits } from "../Layers/working-tree-edits-layer.js";
import type { SessionDiffSession } from "./session-diff.js";

export type WorkingTreeEdit = Omit<SessionDiffEdit, "sessionId"> & {
	readonly session: SessionDiffSession;
};

/**
 * Writes a session's working tree and index for the unstaged diff, one edit at
 * a time across the daemon. Each edit re-reads the file it names and refuses
 * one the user did not see, refuses while the session's agent runs, and writes
 * nothing when git refuses. It never pushes: it invalidates SessionGit, whose
 * change re-lists every viewer.
 */
export class WorkingTreeEdits extends Context.Service<
	WorkingTreeEdits,
	{
		/** Restores the file, or the hunk, to the index; an untracked file is deleted. */
		readonly discard: (
			edit: WorkingTreeEdit,
		) => Effect.Effect<void, SessionDiffEditError>;
		/** Stages the file, or the hunk, through a copy of the index swapped in under git's lock. */
		readonly stage: (
			edit: WorkingTreeEdit,
		) => Effect.Effect<void, SessionDiffEditError>;
	}
>()("WorkingTreeEdits") {}

export const WorkingTreeEditsLive = Layer.effect(
	WorkingTreeEdits,
	makeWorkingTreeEdits,
);
