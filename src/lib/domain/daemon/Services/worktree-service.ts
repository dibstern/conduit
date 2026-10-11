import { Context, type Effect } from "effect";
import type { WorktreeCreationError } from "../../../contracts/worktree.js";

export interface WorktreeFolder {
	readonly path: string;
	readonly projectSlug: string;
	readonly sessionId: string;
}

export interface CreatedWorktrees {
	readonly branchName: string;
	readonly worktrees: Readonly<Record<string, string>>;
	/** Checkout roots and original refs owned by this creation, used only for launch rollback. */
	readonly ownership: readonly {
		readonly folder: string;
		readonly path: string;
		readonly branchName: string;
		readonly head: string;
	}[];
}

export interface WorktreeService {
	readonly create: (
		folders: readonly WorktreeFolder[],
		baseBranches?: Readonly<Record<string, string>>,
		branchName?: string,
	) => Effect.Effect<CreatedWorktrees, WorktreeCreationError>;
	/** Undo an uncommitted launch; this is not the session deletion policy. */
	readonly rollback: (
		created: CreatedWorktrees,
	) => Effect.Effect<void, WorktreeCreationError>;
}

export class WorktreeServiceTag extends Context.Tag("WorktreeService")<
	WorktreeServiceTag,
	WorktreeService
>() {}
