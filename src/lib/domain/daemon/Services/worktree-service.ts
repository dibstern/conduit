import { Context, type Effect, type Stream } from "effect";
import type { SessionWorktreeOwnership } from "../../../contracts/session-workspace.js";
import type {
	WorkspaceMissing,
	WorktreeBranchRenameError,
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

export interface WorktreeSetupResult {
	readonly _tag: "finished";
	readonly status: "succeeded" | "failed" | "timed_out";
	readonly exitCode?: number;
	readonly message?: string;
}

export type WorktreeSetupUpdate =
	| { readonly _tag: "output"; readonly output: string }
	| WorktreeSetupResult;

export interface WorktreeService {
	/** Validate all owned checkouts before renaming; restore refs on a Git failure. */
	readonly renameBranch: (
		ownership: readonly SessionWorktreeOwnership[],
		newName: string,
	) => Effect.Effect<void, WorktreeBranchRenameError>;
	/** Own the setup process group until completion or stream interruption. */
	readonly runSetup: (
		effectiveWorkingDirectory: string,
		script: string,
		env: Readonly<Record<string, string | undefined>>,
	) => Stream.Stream<WorktreeSetupUpdate>;
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
	/** Read Git's registration, including prunable entries, without changing refs; fall back to the recorded branch only when Git has none. */
	readonly inspectMissing: (
		folder: WorktreeFolder,
		directory?: string,
		/** Recorded Project Folders can share a checkout created for any one of them. */
		workspaceFolders?: readonly string[],
		recordedBranch?: string,
	) => Effect.Effect<WorkspaceMissing | undefined, WorktreeRecoveryError>;
	/** Re-add an owned checkout from its existing branch; Git's registration takes precedence over recordedBranch. Never create a branch. */
	readonly recreate: (
		folder: WorktreeFolder,
		directory?: string,
		workspaceFolders?: readonly string[],
		recordedBranch?: string,
	) => Effect.Effect<string, WorktreeRecoveryError>;
	/** Restore missing checkouts together, using recorded branches only when registrations lack them; keep present checkouts and all refs. */
	readonly recreateAll: (
		folders: readonly {
			readonly folder: WorktreeFolder;
			readonly directory: string;
			readonly recordedBranch?: string;
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
