import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";

/**
 * The only writer of `sessions.seen_version` (ADR-0004, Scope). Read state is a
 * per-viewer annotation on the log, like a Matrix read marker, not an event:
 * each write stamps the row through the commit seam, whose post-commit advance
 * is what tells every other window. Both writes are quiet no-ops for unknown
 * ids, sessions with no turn end, and sub-agents (a child with no fork point),
 * and both return whether the row changed.
 *
 * test/unit/persistence/seen-version-writer-grep.test.ts keeps every other
 * file from writing the column.
 */

const MARKABLE =
	"last_turn_end_version IS NOT NULL AND (parent_id IS NULL OR fork_point_event IS NOT NULL OR fork_point_timestamp IS NOT NULL)";

const writeSeen = (
	sessionId: string,
	seen: string,
	params: readonly number[],
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const commitAndSignal = yield* makeCommitAndSignal;
		const stamped = yield* commitAndSignal.write((_project, stamp) =>
			stamp((version) =>
				sql
					.unsafe<{ id: string }>(
						`UPDATE sessions SET seen_version = ${seen}, version = ? WHERE id = ? AND ${MARKABLE} AND ${seen} IS NOT COALESCE(seen_version, -1) RETURNING id`,
						[...params, version, sessionId, ...params],
					)
					.pipe(Effect.map((rows) => rows.map((row) => row.id))),
			),
		);
		return stamped.length > 0;
	});

/**
 * Seen up to `upTo`, capped at the latest turn end and never lowered: a stale
 * report from a window that rendered an older turn end cannot bring a cleared
 * dot back.
 */
export const markSeen = (sessionId: string, upTo: number) =>
	writeSeen(
		sessionId,
		"MAX(COALESCE(seen_version, -1), MIN(?, last_turn_end_version))",
		[upTo],
	);

/** Seen up to just before the latest turn end, so that turn end is unread. */
export const markUnread = (sessionId: string) =>
	writeSeen(sessionId, "last_turn_end_version - 1", []);
