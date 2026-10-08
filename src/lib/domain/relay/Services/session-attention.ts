import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { announceSidebar } from "../../../persistence/effect/sidebar-projection.js";

/**
 * The only writer of `sessions.seen_version` (ADR-0004, Scope). Read state is a
 * per-viewer annotation on the log, like a Matrix read marker, not an event:
 * each write stamps the row through the commit seam, whose post-commit advance
 * is what tells every other window. Both writes are quiet no-ops for unknown
 * ids and sub-agents (a child with no fork point), and both return whether the
 * row changed.
 *
 * A session with no turn end sits at a virtual turn end of -1, matching the
 * generated `unread` column: marking it unread seeds -2, so the user's mark
 * shows a dot until the next pick, and its first real turn end is unread
 * either way.
 *
 * test/unit/persistence/seen-version-writer-grep.test.ts keeps every other
 * file from writing the column.
 */

const MARKABLE =
	"parent_id IS NULL OR fork_point_event IS NOT NULL OR fork_point_timestamp IS NOT NULL";

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
						`UPDATE sessions SET seen_version = ${seen}, version = ? WHERE id = ? AND (${MARKABLE}) AND ${seen} IS NOT COALESCE(seen_version, -1) RETURNING id`,
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
		"MAX(COALESCE(seen_version, -1), MIN(?, COALESCE(last_turn_end_version, -1)))",
		[upTo],
	);

/**
 * Background work (a backgrounded shell, a detached agent) outlives the turn
 * that started it, and its liveness lives in memory, not in the row. Nothing
 * else moves the row when it starts or stops, so stamp it: the advance is what
 * makes a subscriber re-read the session and its `working` attention.
 */
export const announceBackgroundWork = (sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const commitAndSignal = yield* makeCommitAndSignal;
		yield* commitAndSignal.write((_project, stamp) =>
			stamp((version) =>
				sql<{ id: string }>`
					UPDATE sessions SET version = ${version} WHERE id = ${sessionId}
					RETURNING id`.pipe(
					Effect.map((rows) => rows.map((row) => row.id)),
					// Its family's sidebar row cannot see the change either.
					Effect.tap(() => announceSidebar(sessionId, version)),
				),
			),
		);
	});

/** Seen up to just before the latest turn end, so that turn end is unread. */
export const markUnread = (sessionId: string) =>
	writeSeen(sessionId, "COALESCE(last_turn_end_version, -1) - 1", []);
