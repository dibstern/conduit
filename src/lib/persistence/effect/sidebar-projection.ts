// Upkeep of the sidebar table (conduit-test-y7eo.2). Every writer that can
// change what a family shows calls `refreshSidebar` in its own transaction,
// with the sessions it wrote: the session projector, the approval projector
// and the commit seam's direct stamps. Each family is found through the stored
// `root_id`, so a refresh reads the touched families and nothing else.

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

/**
 * Recompute the sidebar rows of the families `sessionIds` belong to, plus
 * `formerRoots`: sessions that were top-level, or whose family lost a member,
 * before this write. A candidate that is no longer a top-level session loses
 * its row. Rows that did not visibly change are left as they are.
 */
export const refreshSidebar = (
	sessionIds: readonly string[],
	version: number,
	formerRoots: readonly string[] = [],
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		if (sessionIds.length === 0 && formerRoots.length === 0) return;
		const sql = yield* SqlClient.SqlClient;
		const candidates = yield* sql<{ root_id: string }>`
			SELECT root_id FROM sessions
			WHERE id IN (SELECT value FROM json_each(${JSON.stringify(sessionIds)}))
			AND root_id IS NOT NULL
			UNION SELECT value FROM json_each(${JSON.stringify(formerRoots)})`;
		const roots = JSON.stringify(candidates.map((row) => row.root_id));
		const family = yield* sql<SessionRow>`
			SELECT * FROM sessions
			WHERE root_id IN (SELECT value FROM json_each(${roots}))`;
		const [approvals, stored] = yield* Effect.all([
			sql<PendingApprovalCountRow>`
				SELECT session_id, type, COUNT(*) AS pending_count
				FROM pending_approvals
				WHERE status = 'pending'
				AND session_id IN (SELECT value FROM json_each(${JSON.stringify(family.map((row) => row.id))}))
				GROUP BY session_id, type`,
			sql<{ session_id: string; row: string }>`
				SELECT session_id, row FROM session_sidebar
				WHERE session_id IN (SELECT value FROM json_each(${roots}))`,
		]);
		const next = sidebarRows(family, approvals, version);
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
 * it and everything beneath it. Returns the families the write can have
 * changed besides the session's own: the one it left, and its own row if it
 * was top-level and no longer is.
 */
export const rerootSession = (
	sessionId: string,
): Effect.Effect<readonly string[], SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [row] = yield* sql<{ root_id: string | null; next: string }>`
			SELECT s.root_id, COALESCE(parent.root_id, s.parent_id, s.id) AS next
			FROM sessions s LEFT JOIN sessions parent ON parent.id = s.parent_id
			WHERE s.id = ${sessionId}`;
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
 * The sidebar row of every top-level session in `family`, which must hold
 * whole families. Pure: the same roll-up the full session list computes.
 */
export const sidebarRows = (
	family: readonly SessionRow[],
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
	const roots = family.filter((row) => row.parent_id === null);
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
		members.set(root, [...(members.get(root) ?? []), row.id]);
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
