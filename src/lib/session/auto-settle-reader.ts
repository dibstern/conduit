import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import type { SessionRow } from "../persistence/read-model-types.js";
import { deriveSessionSnooze } from "../persistence/session-list-adapter.js";
import {
	type AutoSettleFacts,
	type AutoSettleTurn,
	sessionRowToAutoSettleFacts,
} from "./auto-settle-policy.js";

interface LatestTurnRow {
	session_id: string;
	state: string;
	requested_at: number | null;
	started_at: number | null;
	completed_at: number | null;
}

export const readPersistedAutoSettleFacts = (now: number, sessionId?: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<SessionRow>`SELECT * FROM sessions
			WHERE parent_id IS NULL AND ${sessionId === undefined ? sql`1 = 1` : sql`id = ${sessionId}`}`;
		if (rows.length === 0) return new Map<string, AutoSettleFacts>();
		const ids = rows.map((row) => row.id);
		const placeholders = ids.map(() => "?").join(",");
		const turns = yield* sql.unsafe<LatestTurnRow>(
			// Latest turn per session only: this runs every minute over every session.
			`SELECT session_id, state, requested_at, started_at, completed_at FROM (
				SELECT session_id, state, requested_at, started_at, completed_at,
					ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY requested_at DESC, rowid DESC) AS rank
				FROM turns WHERE session_id IN (${placeholders})
			) WHERE rank = 1`,
			ids,
		);
		const users = yield* sql.unsafe<{ session_id: string; created_at: number }>(
			`SELECT session_id, MAX(created_at) AS created_at
			FROM messages WHERE role = 'user' AND session_id IN (${placeholders}) GROUP BY session_id`,
			ids,
		);
		const pending = yield* sql.unsafe<{ session_id: string }>(
			`SELECT DISTINCT session_id FROM pending_approvals
			WHERE status = 'pending' AND session_id IN (${placeholders})`,
			ids,
		);
		const turnBySession = new Map<string, AutoSettleTurn>();
		for (const turn of turns) {
			if (!turnBySession.has(turn.session_id))
				turnBySession.set(turn.session_id, {
					state: turn.state,
					requestedAt: turn.requested_at,
					startedAt: turn.started_at,
					completedAt: turn.completed_at,
				});
		}
		const userBySession = new Map<string, number>();
		for (const user of users) {
			if (!userBySession.has(user.session_id))
				userBySession.set(user.session_id, user.created_at);
		}
		const pendingIds = new Set(pending.map((item) => item.session_id));
		return new Map(
			rows.map((row) => [
				row.id,
				sessionRowToAutoSettleFacts(row, {
					latestTurn: turnBySession.get(row.id) ?? null,
					latestUserMessageAt: userBySession.get(row.id) ?? null,
					hasPendingApproval: pendingIds.has(row.id),
					hasLiveBackgroundWork: false,
					hasViewer: false,
					isSnoozed: deriveSessionSnooze(row, now).snoozedAt !== undefined,
				}),
			]),
		);
	});
