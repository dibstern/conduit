import { Context, type Effect } from "effect";
import type { SessionWorktreeOwnership } from "../../../contracts/session-workspace.js";
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
	/** Checkout roots and original refs, retained by the canonical launch event. */
	readonly ownership: readonly SessionWorktreeOwnership[];
}

export interface WorktreeService {
	/** Read-only proof for historical launch events that predate ownership metadata. */
	readonly legacyOwnership: (
		folder: WorktreeFolder,
		directory: string,
	) => Effect.Effect<
		SessionWorktreeOwnership | undefined,
		WorktreeRecoveryError
	>;
	/** Read local Git state for the exact launch-owned checkout; no fetch or prune. */
	readonly inspectRemoval: (
		folder: WorktreeFolder,
		owned: SessionWorktreeOwnership,
	) => Effect.Effect<readonly string[], WorktreeRecoveryError>;
	/** Recheck dirtiness and remove without force; guarded branch deletion follows removal. */
	readonly remove: <R = never>(
		folder: WorktreeFolder,
		owned: SessionWorktreeOwnership,
		inUse?: Effect.Effect<boolean, WorktreeRecoveryError, R>,
	) => Effect.Effect<void, WorktreeRecoveryError, R>;
	/** Read Git's registration, including prunable entries, without changing any refs. */
	readonly inspectMissing: (
		folder: WorktreeFolder,
		directory?: string,
		/** Recorded Project Folders can share a checkout created for any one of them. */
		workspaceFolders?: readonly string[],
	) => Effect.Effect<WorkspaceMissing | undefined, WorktreeRecoveryError>;
	/** Re-add an owned checkout from its existing branch; never create a new branch. */
	readonly recreate: (
		folder: WorktreeFolder,
		directory?: string,
		workspaceFolders?: readonly string[],
	) => Effect.Effect<string, WorktreeRecoveryError>;
	/** Restore missing checkouts together, keeping present checkouts and all branch refs. */
	readonly recreateAll: (
		folders: readonly {
			readonly folder: WorktreeFolder;
			readonly directory: string;
		}[],
	) => Effect.Effect<void, WorktreeRecoveryError>;
	/** One branch in every git folder; optional bases name local branches. Non-git folders stay in place. Failure rolls back all ownership. */
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
