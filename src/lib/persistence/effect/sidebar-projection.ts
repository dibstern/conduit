// Upkeep of the sidebar table (conduit-test-y7eo.2). The session and approval
// projectors name the sessions whose families they may have changed, and the
// projection runner and the commit seam's direct stamps call `refreshSidebar`
// once per transaction with all of them. Each family is found through the
// stored `root_id`, so a refresh reads the touched families and nothing else,
// once: its cost is the family's size, not that times the commit's events.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Schema } from "effect";
import type {
	PendingApprovalCountRow,
	SessionRow,
} from "../read-model-types.js";
import {
	changeSidebarRow,
	type SidebarRow,
	SidebarRowSchema,
} from "../sidebar-row.js";
import {
	pendingApprovalCountsByType,
	sessionRowsToSessionInfoList,
} from "./read-query-effect.js";

const decodeRow = Schema.decodeUnknownSync(Schema.parseJson(SidebarRowSchema));
const encodeRow = Schema.encodeSync(Schema.parseJson(SidebarRowSchema));

/** What a family member contributes to its root's row. */
export type FamilyMember = Pick<
	SessionRow,
	"id" | "parent_id" | "side_thread" | "unread" | "status"
>;

/**
 * Recompute the sidebar rows of the families `sessionIds` belong to, and of
 * any of them that held a row before this write: a session deleted, or a root
 * that gained a parent, names the family it left. A candidate that is not a
 * top-level session now loses its row. Rows that did not visibly change are
 * left as they are.
 */
export const refreshSidebar = (
	sessionIds: readonly string[],
	version: number,
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		if (sessionIds.length === 0) return;
		const sql = yield* SqlClient.SqlClient;
		const ids = JSON.stringify(sessionIds);
		const candidates = yield* sql<{ root_id: string }>`
			SELECT root_id FROM sessions
			WHERE id IN (SELECT value FROM json_each(${ids}))
			AND root_id IS NOT NULL
			UNION SELECT value FROM json_each(${ids})`;
		const roots = JSON.stringify(candidates.map((row) => row.root_id));
		// Whole rows for the roots alone; the rest of the family only rolls up.
		const [top, family, approvals, stored] = yield* Effect.all([
			sql<SessionRow>`
				SELECT * FROM sessions
				WHERE id IN (SELECT value FROM json_each(${roots}))
				AND parent_id IS NULL`,
			sql<FamilyMember>`
				SELECT id, parent_id, side_thread, unread, status FROM sessions
				WHERE root_id IN (SELECT value FROM json_each(${roots}))`,
			sql<PendingApprovalCountRow>`
				SELECT a.session_id, a.type, COUNT(*) AS pending_count
				FROM pending_approvals a JOIN sessions s ON s.id = a.session_id
				WHERE a.status = 'pending'
				AND s.root_id IN (SELECT value FROM json_each(${roots}))
				GROUP BY a.session_id, a.type`,
			sql<{ session_id: string; row: string }>`
				SELECT session_id, row FROM session_sidebar
				WHERE session_id IN (SELECT value FROM json_each(${roots}))`,
		]);
		const next = sidebarRows(top, family, approvals, version);
		const storedRows = new Map(
			stored.map((row) => [row.session_id, decodeRow(row.row)]),
		);
		for (const { root_id: rootId } of candidates) {
			const row = next.get(rootId);
			if (row === undefined) {
				if (storedRows.has(rootId))
					yield* sql`DELETE FROM session_sidebar WHERE session_id = ${rootId}`;
				continue;
			}
			const { changed } = changeSidebarRow(storedRows.get(rootId), row);
			if (!changed) continue;
			yield* sql`
				INSERT INTO session_sidebar (session_id, version, last_activity, row)
				VALUES (${rootId}, ${row.version}, ${row.lastActivity}, ${encodeRow(row)})
				ON CONFLICT (session_id) DO UPDATE SET
					version = excluded.version,
					last_activity = excluded.last_activity,
					row = excluded.row`;
		}
	});

/**
 * Store the top-level parent of a session whose parent was just written, for
 * it and everything beneath it. Returns the sessions whose families the write
 * can have changed: its own, the one it left, and its own row if it was
 * top-level and no longer is.
 *
 * The top is found by walking up, as the migration's backfill walks down, so
 * both agree on a session whose chain never reaches a top-level one: an orphan
 * (its parent is missing) or a member of a parent cycle has no root, and no
 * family shows it, as the full session list does not.
 */
export const rerootSession = (
	sessionId: string,
): Effect.Effect<readonly string[], SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [row] = yield* sql<{ root_id: string | null; next: string | null }>`
			WITH RECURSIVE up(id, parent_id) AS (
				SELECT id, parent_id FROM sessions WHERE id = ${sessionId}
				UNION
				SELECT s.id, s.parent_id FROM sessions s JOIN up ON s.id = up.parent_id
			)
			SELECT root_id, (SELECT id FROM up WHERE parent_id IS NULL) AS next
			FROM sessions WHERE id = ${sessionId}`;
		if (row === undefined) return [];
		if (row.root_id !== row.next)
			yield* sql`
				WITH RECURSIVE subtree(id) AS (
					SELECT ${sessionId}
					UNION
					SELECT child.id FROM sessions child
					JOIN subtree ON child.parent_id = subtree.id
				)
				UPDATE sessions SET root_id = ${row.next}
				WHERE id IN (SELECT id FROM subtree)`;
		return row.root_id === null ? [sessionId] : [sessionId, row.root_id];
	});

/**
 * Background work is not stored, so the change rule cannot see it start or
 * stop. Announcing it is the family's visible change: the row moves, and takes
 * its root's last activity as any visible change does.
 */
export const announceSidebar = (sessionId: string, version: number) =>
	Effect.flatMap(
		SqlClient.SqlClient,
		(sql) => sql`
			UPDATE session_sidebar SET
				version = ${version},
				last_activity = root.updated_at,
				row = json_set(row, '$.version', ${version}, '$.lastActivity', root.updated_at)
			FROM sessions root
			WHERE root.id = session_sidebar.session_id
			AND session_sidebar.session_id = (SELECT root_id FROM sessions WHERE id = ${sessionId})`,
	);

/**
 * The sidebar row of every session in `roots`, whose whole families `family`
 * must hold. Pure: the same roll-up the full session list computes.
 */
export const sidebarRows = (
	roots: readonly SessionRow[],
	family: readonly FamilyMember[],
	approvals: readonly PendingApprovalCountRow[],
	version: number,
): ReadonlyMap<string, SidebarRow> => {
	const parentMap = new Map(
		family.flatMap((row) =>
			row.parent_id === null ? [] : [[row.id, row.parent_id] as const],
		),
	);
	const sideThreadIds = new Set(
		family.flatMap((row) => (row.side_thread === 1 ? [row.id] : [])),
	);
	const pending = pendingApprovalCountsByType(approvals);
	const items = sessionRowsToSessionInfoList(roots, {
		parentMap,
		sideThreadIds,
		unreadSessionIds: new Set(
			family.flatMap((row) => (row.unread === 1 ? [row.id] : [])),
		),
		statuses: Object.fromEntries(
			family.map((row) => [row.id, { type: row.status }]),
		),
		pendingQuestionCounts: pending.questions,
		pendingPermissionCounts: pending.permissions,
	});
	// A session's activity stops at the first side thread above it.
	const activityRoot = (id: string): string => {
		const seen = new Set<string>();
		let at = id;
		while (!sideThreadIds.has(at) && !seen.has(at)) {
			seen.add(at);
			const parent = parentMap.get(at);
			if (parent === undefined) return at;
			at = parent;
		}
		return at;
	};
	const members = new Map<string, string[]>();
	for (const row of family) {
		const root = activityRoot(row.id);
		const group = members.get(root);
		if (group === undefined) members.set(root, [row.id]);
		else group.push(row.id);
	}
	return new Map(
		roots.flatMap((root, index) => {
			const item = items[index];
			if (item === undefined) return [];
			const {
				updatedAt: _updatedAt,
				snoozedAt: _snoozedAt,
				snoozedUntil: _snoozedUntil,
				wokenAt: _wokenAt,
				wokeBecause: _wokeBecause,
				...session
			} = item;
			return [
				[
					root.id,
					{
						version,
						lastActivity: root.updated_at,
						members: (members.get(root.id) ?? []).sort(),
						snooze: {
							snoozed_at: root.snoozed_at,
							snoozed_until: root.snoozed_until,
							woken_at: root.woken_at,
							woken_reason: root.woken_reason,
						},
						session,
					},
				],
			];
		}),
	);
};
