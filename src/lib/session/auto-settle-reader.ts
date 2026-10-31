import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { SessionWorkspaceSchema } from "../contracts/session-workspace.js";
import { ReadRequest } from "../domain/daemon/Services/read-request.js";
import { SessionGit } from "../domain/daemon/Services/session-git.js";
import { deriveSessionSnooze } from "../persistence/effect/read-query-effect.js";
import { readPublishedSessionGit } from "../persistence/effect/session-git-publication.js";
import type { SessionRow } from "../persistence/read-model-types.js";
import {
	type AutoSettleFacts,
	type AutoSettleTurn,
	sessionRowToAutoSettleFacts,
} from "./auto-settle-policy.js";
import { effectiveWorkingDirectory } from "./session-workspace.js";

interface LatestTurnRow {
	session_id: string;
	state: string;
	requested_at: number | null;
	started_at: number | null;
	completed_at: number | null;
}

export const readPersistedAutoSettleFacts = (
	projectId: string,
	now: number,
	sessionId?: string,
	projectDir?: string,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		// Discovery skips children up front; the policy turns them off either way.
		const rows = yield* sql<SessionRow>`SELECT * FROM sessions
			WHERE project_id = ${projectId}
				AND ${sessionId === undefined ? sql`parent_id IS NULL` : sql`id = ${sessionId}`}`;
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
		const directoryBySession = new Map<string, string>();
		if (projectDir !== undefined) {
			for (const row of rows) {
				if (row.workspace === null || row.settled_at !== null) continue;
				const workspace = Schema.decodeUnknownOption(
					Schema.fromJsonString(SessionWorkspaceSchema),
				)(row.workspace);
				if (Option.isNone(workspace)) continue;
				const directory = effectiveWorkingDirectory(
					projectDir,
					workspace.value,
				);
				if (directory !== projectDir) directoryBySession.set(row.id, directory);
			}
		}
		const sessionGit = yield* Effect.serviceOption(SessionGit);
		const gitBySession = new Map(
			yield* Effect.forEach([...directoryBySession.keys()], (id) =>
				(sessionGit._tag === "Some"
					? sessionGit.value.read(id)
					: readPublishedSessionGit(
							id,
							projectDir === undefined ? undefined : [projectDir],
						)
				).pipe(
					Effect.provideService(ReadRequest, "ReadAutoSettle"),
					Effect.map((git) => [id, git] as const),
				),
			),
		);
		return new Map(
			rows.map((row) => [
				row.id,
				sessionRowToAutoSettleFacts(row, {
					mergedAt: gitBySession.get(row.id)?.mergedAt,
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
