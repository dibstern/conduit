import { Context, Data, type Effect, Layer } from "effect";
import { makeFolderTimeline } from "../Layers/folder-timeline-layer.js";
import type { SubprocessResult } from "./subprocess.js";

/** One instant of a folder: its index and working tree as trees in the private store. */
export interface FolderSnapshot {
	/** Opaque store handle for `git`. */
	readonly store: string;
	/** The folder's path inside its repository, "" or ending in "/". */
	readonly prefix: string;
	readonly index: string;
	readonly worktree: string;
}

export class FolderTimelineError extends Data.TaggedError(
	"FolderTimelineError",
)<{
	readonly reason: "failed" | "timeout";
	readonly message: string;
}> {}

/**
 * Sole owner of the private object stores. A store borrows its repository's
 * objects read-only and never writes into the repository; live snapshots get
 * no ref and are pruned after a grace period.
 */
export class FolderTimeline extends Context.Service<
	FolderTimeline,
	{
		/** Single-flight per folder. */
		readonly snapshot: (
			directory: string,
		) => Effect.Effect<FolderSnapshot, FolderTimelineError>;
		/** Read-only git against a snapshot's store. */
		readonly git: (
			store: string,
			args: readonly string[],
			options?: { readonly input?: string; readonly maxBuffer?: number },
		) => Effect.Effect<SubprocessResult, FolderTimelineError>;
		/** Read-only git in the folder's own repository, for the refs and history a store lacks. */
		readonly folderGit: (
			directory: string,
			args: readonly string[],
		) => Effect.Effect<SubprocessResult, FolderTimelineError>;
		/** Prune snapshot objects older than the grace period. */
		readonly collect: (graceMs: number) => Effect.Effect<void>;
	}
>()("FolderTimeline") {}

export const FolderTimelineLive = (configDir: string) =>
	Layer.effect(FolderTimeline, makeFolderTimeline(configDir));
