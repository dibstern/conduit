import { Context, Data, type Effect, Layer } from "effect";
import type { RunChangesCaptured } from "../../../contracts/stored-event.js";
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
 * no ref and are pruned after a grace period. A run's start tree is pinned
 * until its end checkpoint; captures are copied into the session's own store
 * under one ref, so they outlive the user's history and leave with the session.
 */
export class FolderTimeline extends Context.Service<
	FolderTimeline,
	{
		/**
		 * Single-flight per folder. With `paths` (folder-relative), a snapshot of
		 * its own, taken now, that re-hashes only those paths: elsewhere its
		 * worktree tree is the index.
		 */
		readonly snapshot: (
			directory: string,
			paths?: readonly string[],
		) => Effect.Effect<FolderSnapshot, FolderTimelineError>;
		/** Read-only git against a snapshot's store. */
		readonly git: (
			store: string,
			args: readonly string[],
			options?: {
				readonly input?: string;
				readonly maxBuffer?: number;
				/** Raw stdout bytes, for output that may not be UTF-8. */
				readonly onStdout?: (chunk: Buffer) => void;
			},
		) => Effect.Effect<SubprocessResult, FolderTimelineError>;
		/** Read-only git in the folder's own repository, for the refs and history a store lacks. */
		readonly folderGit: (
			directory: string,
			args: readonly string[],
		) => Effect.Effect<SubprocessResult, FolderTimelineError>;
		/** Prune snapshot objects older than the grace period, and pins of runs no longer live. */
		readonly collect: (graceMs: number) => Effect.Effect<void>;
		/**
		 * The start checkpoint of each folder, within a budget. A folder that
		 * fails or runs over records a gap; the run always proceeds.
		 */
		readonly runStarted: (run: {
			readonly sessionId: string;
			readonly runId: string;
			readonly directories: readonly string[];
		}) => Effect.Effect<void>;
		/** A steer folded into a running run: its own checkpoint is dropped. */
		readonly runJoined: (runId: string) => Effect.Effect<void>;
		/**
		 * The end checkpoint: copies the run's changes into the session's store
		 * and hands them to `record`. A run without a start checkpoint records
		 * nothing.
		 */
		readonly runEnded: <E>(
			runId: string,
			record: (
				sessionId: string,
				capture: RunChangesCaptured,
			) => Effect.Effect<void, E>,
		) => Effect.Effect<void>;
		/** Waits, bounded, until a live run's capture is recorded. */
		readonly settled: (runId: string) => Effect.Effect<void>;
		/** The store holding a session's captures, for `git`. */
		readonly sessionStore: (sessionId: string) => string;
		/** Drops the session's live runs and its captures. */
		readonly forget: (sessionId: string) => Effect.Effect<void>;
	}
>()("FolderTimeline") {}

export const FolderTimelineLive = (configDir: string) =>
	Layer.effect(FolderTimeline, makeFolderTimeline(configDir));
