import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import { deriveSessionSnooze } from "../persistence/effect/read-query-effect.js";
import type { SessionRow } from "../persistence/read-model-types.js";
import {
	type AutoArchiveFacts,
	shouldArchiveIdleSession,
} from "./auto-archive-policy.js";

export const readPersistedAutoArchiveFacts = (
	projectId: string,
	now: number,
	sessionId?: string,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		// Archiving hides the whole family, so any descendant's activity, running
		// work, open approval or queued input keeps the root visible.
		const rows = yield* sql<
			SessionRow & { last_activity_at: number; pending_work: number }
		>`
			SELECT s.*,
				MAX(COALESCE(s.last_message_at, s.created_at),
					COALESCE((SELECT MAX(COALESCE(f.last_message_at, f.created_at)) FROM sessions f WHERE f.root_id = s.id), 0),
					COALESCE((SELECT MAX(MAX(COALESCE(t.requested_at, 0), COALESCE(t.started_at, 0), COALESCE(t.completed_at, 0)))
						FROM turns t JOIN sessions f ON f.id = t.session_id WHERE f.root_id = s.id), 0),
					COALESCE((SELECT MAX(m.created_at) FROM messages m JOIN sessions f ON f.id = m.session_id WHERE f.root_id = s.id), 0),
					COALESCE((SELECT MAX(i.admitted_at) FROM pending_inputs i JOIN sessions f ON f.id = i.session_id WHERE f.root_id = s.id), 0)) AS last_activity_at,
				(EXISTS(SELECT 1 FROM sessions f WHERE f.root_id = s.id AND f.status IN ('busy', 'retry'))
					OR EXISTS(SELECT 1 FROM turns t JOIN sessions f ON f.id = t.session_id WHERE f.root_id = s.id AND t.state IN ('pending', 'running'))
					OR EXISTS(SELECT 1 FROM pending_approvals a JOIN sessions f ON f.id = a.session_id WHERE f.root_id = s.id AND a.status = 'pending')
					OR EXISTS(SELECT 1 FROM pending_inputs i JOIN sessions f ON f.id = i.session_id WHERE f.root_id = s.id AND i.state IN ('queued', 'steering'))) AS pending_work
			FROM sessions s WHERE s.project_id = ${projectId}
				AND ${sessionId === undefined ? sql`s.parent_id IS NULL AND s.settled_at IS NOT NULL AND s.archived_at IS NULL` : sql`s.id = ${sessionId}`}`;
		return new Map<string, AutoArchiveFacts>(
			rows.map((row) => [
				row.id,
				{
					settledAt: row.settled_at,
					archivedAt: row.archived_at ?? null,
					unarchivedAt: row.unarchived_at ?? null,
					lastActivityAt: row.last_activity_at,
					status: row.status,
					snoozed: deriveSessionSnooze(row, now).snoozedAt !== undefined,
					pinnedAt: row.pinned_at,
					hasPendingWork: row.pending_work !== 0,
					hasLiveBackgroundWork: false,
				},
			]),
		);
	});

export const archiveIdleSessions = <ArchiveError>(
	ports: {
		readonly hasLiveBackgroundWork: (sessionId: string) => boolean;
		/** Rechecks the policy under the triage lock before writing. */
		readonly setArchived: (
			sessionId: string,
		) => Effect.Effect<boolean, ArchiveError>;
	},
	idleWindowMs: number,
	now: number,
): Effect.Effect<
	number,
	SqlError | ArchiveError,
	SqlClient.SqlClient | PersistenceProjectTag
> =>
	Effect.gen(function* () {
		const { projectId } = yield* PersistenceProjectTag;
		const candidates = yield* readPersistedAutoArchiveFacts(projectId, now);
		let archived = 0;
		for (const [sessionId, facts] of candidates) {
			if (
				!shouldArchiveIdleSession(
					{
						...facts,
						hasLiveBackgroundWork: ports.hasLiveBackgroundWork(sessionId),
					},
					now,
					idleWindowMs,
				)
			)
				continue;
			if (yield* ports.setArchived(sessionId)) archived++;
		}
		return archived;
	});
