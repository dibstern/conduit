import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
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

const MARKABLE = "parent_id IS NULL OR side_thread = 1";

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
		const { projectId } = yield* EventStoreEffectTag;
		const commitAndSignal = yield* makeCommitAndSignal;
		yield* commitAndSignal.write((_project, stamp) =>
			stamp((version) =>
				sql<{ id: string }>`
					UPDATE sessions SET version = ${version}
					WHERE id = ${sessionId} AND project_id = ${projectId}
					RETURNING id`.pipe(
					Effect.map((rows) => rows.map((row) => row.id)),
					// Its family's sidebar row cannot see the change either.
					Effect.tap((ids) =>
						ids.length > 0 ? announceSidebar(sessionId, version) : Effect.void,
					),
				),
			),
		);
	});

/** Seen up to just before the latest turn end, so that turn end is unread. */
export const markUnread = (sessionId: string) =>
	writeSeen(sessionId, "COALESCE(last_turn_end_version, -1) - 1", []);

/**
 * Per-message read state (plan decision 11): a row in `message_part_read_state`
 * means read. It is keyed by session and part, outside the replay-owned part
 * rows, so a projector rebuild never resets it, and session deletion cascades.
 * Only the session's own text parts can be marked. The stamp moves the parts'
 * and their messages' versions, which is what re-sends them to every window.
 * The sidebar's seen marker is untouched.
 */
export const setRead = (
	partIds: readonly string[],
	read: boolean,
	sessionId: string,
) =>
	Effect.gen(function* () {
		if (partIds.length === 0) return false;
		const sql = yield* SqlClient.SqlClient;
		const { projectId } = yield* EventStoreEffectTag;
		const commitAndSignal = yield* makeCommitAndSignal;
		const changed = yield* commitAndSignal.write((_project, stamp) =>
			stamp((version) =>
				Effect.gen(function* () {
					const parts = sql`
						SELECT p.id FROM message_parts p
						JOIN messages m ON m.id = p.message_id
						JOIN sessions s ON s.id = m.session_id
						WHERE s.id = ${sessionId} AND s.project_id = ${projectId} AND p.type = 'text'
							AND p.id IN (SELECT value FROM json_each(${JSON.stringify(partIds)}))`;
					const rows = read
						? yield* sql<{ part_id: string }>`
							INSERT INTO message_part_read_state (session_id, part_id)
							SELECT ${sessionId}, id FROM (${parts}) WHERE 1
							ON CONFLICT DO NOTHING RETURNING part_id`
						: yield* sql<{ part_id: string }>`
							DELETE FROM message_part_read_state
							WHERE session_id = ${sessionId} AND part_id IN (${parts})
							RETURNING part_id`;
					if (rows.length === 0) return [];
					const ids = JSON.stringify(rows.map((row) => row.part_id));
					yield* sql`UPDATE message_parts SET version = ${version}
						WHERE id IN (SELECT value FROM json_each(${ids}))`;
					yield* sql`UPDATE messages SET version = ${version}
						WHERE id IN (SELECT message_id FROM message_parts
							WHERE id IN (SELECT value FROM json_each(${ids})))`;
					return [sessionId];
				}),
			),
		);
		return changed.length > 0;
	});

/** A conduit-side fork copies the parent's parts as `<part>_<fork>` inside its
 * creation commit, so the copies start with the parent's read state. */
export const inheritRead = (parentId: string, forkId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			INSERT INTO message_part_read_state (session_id, part_id)
			SELECT ${forkId}, p.id FROM message_part_read_state r
			JOIN message_parts p ON p.id = r.part_id || '_' || ${forkId}
			WHERE r.session_id = ${parentId}
			ON CONFLICT DO NOTHING`;
	});
