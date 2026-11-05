import { Context, Data, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
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

/** A run's folder at its start and end, kept for head moves with files. */
export interface Checkpoint {
	readonly store: string;
	readonly prefix: string;
	/** Repository-wide worktree trees; the folder is under `prefix`. */
	readonly start: string;
	readonly end: string;
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
 * no ref and are pruned after a grace period. A run's checkpoints are pinned
 * until its capture is recorded, so a restart can finish it; captures are copied into the session's own store
 * under one ref, so they outlive the user's history and leave with the session.
 * The whole-folder checkpoints then stay in the repository's store, for head
 * moves with files, until the session is evicted or forgotten.
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
		/**
		 * Startup: takes back the runs a restart left pinned. `owed` says what
		 * became of each: an "ended" run is captured from its pinned checkpoints
		 * (a folder whose end checkpoint was lost records a gap), a "running" run
		 * is live again, and a "done" run (recorded, or its session gone) is
		 * unpinned. Returns once they are live; captures run on.
		 */
		readonly recover: <E>(
			owed: (
				sessionId: string,
				runId: string,
			) => Effect.Effect<"ended" | "running" | "done">,
			record: (
				sessionId: string,
				capture: RunChangesCaptured,
			) => Effect.Effect<void, E>,
		) => Effect.Effect<void>;
		/**
		 * Waits until a live run's capture is recorded or abandoned (failed, or
		 * its session forgotten); at once for a run the timeline no longer holds.
		 */
		readonly settled: (runId: string) => Effect.Effect<void>;
		/** The store holding a session's captures, for `git`. */
		readonly sessionStore: (sessionId: string) => string;
		/**
		 * The run's whole-folder checkpoint in `directory`, kept from its
		 * capture until the session is evicted or forgotten.
		 */
		readonly checkpoint: (
			sessionId: string,
			runId: string,
			directory: string,
		) => Effect.Effect<Checkpoint | undefined, FolderTimelineError>;
		/** Bytes the session's store holds on disk; 0 without one. */
		readonly storeBytes: (sessionId: string) => Effect.Effect<number>;
		/** Bytes all session stores hold on disk. */
		readonly diskUse: Effect.Effect<number>;
		/**
		 * Evicts the session's captures, serialized with its captures: `append`
		 * records the eviction (false declines it), then the session's ref is
		 * deleted and its store pruned. Recovery passes an append that already
		 * happened. Returns whether it evicted.
		 */
		readonly evict: <E, R>(
			sessionId: string,
			append: Effect.Effect<boolean, E, R>,
		) => Effect.Effect<boolean, E, R>;
		/** Drops the session's live runs and its captures. */
		readonly forget: (sessionId: string) => Effect.Effect<void>;
	}
>()("FolderTimeline") {}

/** Folder Timeline's eviction against the Daemon Settings budget. */
export class FolderTimelineEviction extends Context.Service<
	FolderTimelineEviction,
	{
		/** Runs a pass after any pass already running, and returns when it ends. */
		readonly pass: Effect.Effect<void>;
	}
>()("FolderTimelineEviction") {}

export const FolderTimelineLive = (configDir: string) =>
	Layer.effect(FolderTimeline, makeFolderTimeline(configDir));

/**
 * Whether the session's history at `sequence` (an event's sequence, such as a
 * turn's capture) is pruned: an eviction came after it, so its files are gone.
 * Durable, read from the event log; eviction is never undone.
 */
export const isPruned = (sessionId: string, sequence: number) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{ readonly hit: number }>`
			SELECT 1 AS hit FROM events
			WHERE session_id = ${sessionId} AND type = 'folder_timeline.evicted' AND sequence > ${sequence}
			LIMIT 1`;
		return rows.length > 0;
	});

/**
 * Whether the files at a head move's target are still there: "pruned" when an
 * eviction came after `messageId` was created, since its run's checkpoints went
 * with it. Head moves that need files refuse "pruned"; conversation-only moves
 * go ahead and show the files unavailable. A message this session did not
 * create (inherited by a fork) never had checkpoints here: "not_available".
 */
export const headMoveFiles = (sessionId: string, messageId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [row] = yield* sql<{ readonly sequence: number | null }>`
			SELECT MIN(sequence) AS sequence FROM events
			WHERE session_id = ${sessionId} AND type = 'message.created'
				AND json_extract(data, '$.messageId') = ${messageId}`;
		const sequence = row?.sequence;
		if (sequence == null) return "not_available" as const;
		return (yield* isPruned(sessionId, sequence))
			? ("pruned" as const)
			: ("available" as const);
	});
