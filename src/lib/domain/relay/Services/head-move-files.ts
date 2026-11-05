import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { FilesRefused } from "../../../contracts/limit-recovery.js";
import { pathToRoot } from "../../../persistence/effect/history-graph.js";
import { loadLedgerView } from "../../../persistence/effect/run-ledger-arm.js";
import {
	FolderRestoreRefused,
	FolderTimeline,
	FolderTimelineError,
	isPruned,
	type RestoreChange,
} from "../../daemon/Services/folder-timeline.js";

/** A folder a head move with files puts back whole: to tree `to`, kept since event `sequence`. */
export interface FilesFolder {
	readonly directory: string;
	readonly from: string;
	readonly to: string;
	readonly sequence: number;
	/** Names the Restore Plan: its paths and each one's state now. */
	readonly key: string;
	readonly changes: readonly RestoreChange[];
}

type Timeline = FolderTimeline["Service"];
interface Target {
	readonly directory: string;
	readonly sequence: number;
	readonly to: string | undefined;
}

/**
 * Where each folder goes (82tn.53). A folder a run joining the Head captured goes to the end of
 * the joining run nearest the target; else one a leaving run captured goes to the start of the
 * oldest leaving run. An undo puts back what the undone move's Restore Receipts hold.
 */
const targets = (
	timeline: Timeline,
	sessionId: string,
	head: string | null,
	to: string | null,
	undoes: string | undefined,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		if (undoes !== undefined) {
			const [entry] = yield* sql<{ sequence: number; files: string | null }>`
				SELECT sequence, json_extract(data, '$.files') AS files FROM events
				WHERE session_id = ${sessionId} AND type = 'head.move_started'
					AND json_extract(data, '$.moveId') = ${undoes}`;
			if (!entry) return [];
			const directories: readonly string[] = entry.files
				? JSON.parse(entry.files)
				: [];
			return yield* Effect.forEach(directories, (directory) =>
				timeline.receipt(sessionId, undoes, directory).pipe(
					Effect.orElseSucceed(() => undefined),
					Effect.map(
						(receipt): Target => ({
							directory,
							sequence: entry.sequence,
							to: receipt?.before,
						}),
					),
				),
			);
		}
		const onHead = yield* pathToRoot(sessionId, head);
		const onTarget = yield* pathToRoot(sessionId, to);
		const joining = onTarget.filter((id) => !onHead.includes(id));
		const leaving = onHead.filter((id) => !onTarget.includes(id)).reverse();
		if (joining.length + leaving.length === 0) return [];
		const captures = yield* sql<{
			node: string;
			runId: string;
			sequence: number;
			started: number | null;
			directory: string;
		}>`
			SELECT n.id AS node, n.run_id AS runId, e.sequence AS sequence,
				json_extract(f.value, '$.directory') AS directory,
				(SELECT MIN(s.sequence) FROM events s WHERE s.session_id = n.session_id
					AND s.type = 'run.started' AND json_extract(s.metadata, '$.runId') = n.run_id) AS started
			FROM history_nodes n
			JOIN events e ON e.session_id = n.session_id AND e.type = 'run.changes_captured'
				AND json_extract(e.data, '$.runId') = n.run_id
			JOIN json_each(e.data, '$.folders') f
			WHERE n.session_id = ${sessionId} AND n.id IN ${sql.in([...joining, ...leaving])}`;
		const chosen = new Map<
			string,
			{ runId: string; side: "start" | "end"; sequence: number }
		>();
		for (const [nodes, side] of [
			[joining, "end"],
			[leaving, "start"],
		] as const)
			for (const node of nodes)
				for (const capture of captures)
					if (capture.node === node && !chosen.has(capture.directory))
						chosen.set(capture.directory, {
							runId: capture.runId,
							side,
							// A start checkpoint is as old as its run's start.
							sequence:
								side === "end" ? capture.sequence : (capture.started ?? 0),
						});
		return yield* Effect.forEach(
			[...chosen],
			([directory, { runId, side, sequence }]) =>
				timeline.checkpoint(sessionId, runId, directory).pipe(
					Effect.orElseSucceed(() => undefined),
					Effect.map(
						(checkpoint): Target => ({
							directory,
							sequence,
							to: checkpoint?.[side],
						}),
					),
				),
		);
	});

/**
 * Why the folder's files cannot go back to what was kept at `sequence`: pruned since, or another
 * session ran in it or restored it after, or has a run open there now. Sessions that never ran
 * there are exempt.
 */
const check = (
	timeline: Timeline,
	sessionId: string,
	directory: string,
	sequence: number,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		if (yield* isPruned(sessionId, sequence))
			return yield* new FilesRefused({
				sessionId,
				reason: "pruned",
				directory,
			});
		const [after] = yield* sql<{ id: string; title: string | null }>`
			SELECT e.session_id AS id, s.title AS title FROM events e
			LEFT JOIN sessions s ON s.id = e.session_id
			WHERE e.sequence > ${sequence} AND e.session_id != ${sessionId}
				AND ((e.type = 'run.changes_captured' AND EXISTS (SELECT 1 FROM json_each(e.data, '$.folders') f
						WHERE json_extract(f.value, '$.directory') = ${directory}))
					OR (e.type = 'head.move_started' AND EXISTS (SELECT 1 FROM json_each(e.data, '$.files') f
						WHERE f.value = ${directory})))
			ORDER BY e.sequence LIMIT 1`;
		if (after)
			return yield* new FilesRefused({
				sessionId,
				reason: "other_session",
				directory,
				other: {
					sessionId: after.id,
					title: after.title ?? "",
					running: false,
				},
			});
		for (const run of yield* timeline.runsIn(directory)) {
			if (run.sessionId === sessionId) continue;
			// CONTRACT.md 2849-2851: every liveness reader asks the Run Ledger's anythingMayAct; the
			// timeline only says which folders the run names.
			const view = yield* loadLedgerView(run.sessionId);
			if (!(view?.anythingMayAct ?? true)) continue;
			const [row] = yield* sql<{ title: string }>`
				SELECT title FROM sessions WHERE id = ${run.sessionId}`;
			return yield* new FilesRefused({
				sessionId,
				reason: "other_session",
				directory,
				other: {
					sessionId: run.sessionId,
					title: row?.title ?? "",
					running: true,
				},
			});
		}
	});

/** The folders a move with files restores and each one's Restore Plan, or why it cannot. */
export const planFiles = (
	sessionId: string,
	head: string | null,
	to: string | null,
	undoes: string | undefined,
) =>
	Effect.gen(function* () {
		const found = yield* Effect.serviceOption(FolderTimeline);
		if (Option.isNone(found))
			return yield* new FilesRefused({ sessionId, reason: "not_available" });
		const timeline = found.value;
		const folders: FilesFolder[] = [];
		for (const { directory, sequence, to: tree } of yield* targets(
			timeline,
			sessionId,
			head,
			to,
			undoes,
		)) {
			yield* check(timeline, sessionId, directory, sequence);
			if (tree === undefined)
				return yield* new FilesRefused({
					sessionId,
					reason: "not_available",
					directory,
				});
			const plan = yield* timeline.plan(directory, tree).pipe(
				Effect.mapError(
					(error) =>
						new FilesRefused({
							sessionId,
							reason:
								error._tag === "FolderRestoreRefused" ? error.reason : "failed",
							directory,
						}),
				),
			);
			folders.push({
				directory,
				from: plan.from,
				to: tree,
				sequence,
				key: plan.key,
				changes: plan.changes,
			});
		}
		return folders;
	});

/**
 * Restores the planned folders and journals the move with `journal`, under each folder's apply
 * lock. The refusals are read again under the lock, so a run started, a restore or an eviction
 * since the plan refuses, and nothing is written.
 */
export const restoreFiles = <A, E, R>(
	sessionId: string,
	moveId: string,
	folders: readonly FilesFolder[],
	journal: Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		const found = yield* Effect.serviceOption(FolderTimeline);
		if (Option.isNone(found))
			return yield* new FilesRefused({ sessionId, reason: "not_available" });
		const timeline = found.value;
		return yield* timeline
			.restore<A, E | FilesRefused | SqlError, R | SqlClient.SqlClient>({
				sessionId,
				moveId,
				folders,
				guard: Effect.forEach(
					folders,
					({ directory, sequence }) =>
						check(timeline, sessionId, directory, sequence),
					{ discard: true },
				),
				journal,
			})
			.pipe(
				Effect.mapError((error) =>
					error instanceof FolderRestoreRefused
						? new FilesRefused({
								sessionId,
								reason: error.reason,
								directory: error.directory,
								paths: error.paths,
							})
						: error instanceof FolderTimelineError
							? new FilesRefused({ sessionId, reason: "failed" })
							: error,
				),
			);
	});
