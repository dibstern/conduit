import { Context, type Effect } from "effect";
import type {
	WorkspaceMissing,
	WorktreeCreationError,
	WorktreeRecoveryError,
} from "../../../contracts/worktree.js";

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
	/** Read Git's registration, including prunable entries, without changing any refs. */
	readonly inspectMissing: (
		folder: WorktreeFolder,
		directory?: string,
	) => Effect.Effect<WorkspaceMissing | undefined, WorktreeRecoveryError>;
	/** Re-add an owned checkout from its existing branch; never create a new branch. */
	readonly recreate: (
		folder: WorktreeFolder,
		directory?: string,
	) => Effect.Effect<string, WorktreeRecoveryError>;
	/** One branch in every git folder; non-git folders stay in place. Failure rolls back all ownership. */
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
