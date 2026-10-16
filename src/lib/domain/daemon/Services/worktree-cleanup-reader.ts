import { existsSync } from "node:fs";
import { SqlClient } from "@effect/sql";
import { Effect, Option } from "effect";
import type { WorktreeCleanup } from "../../../contracts/worktree.js";
import type { StoredProject } from "../../../types.js";
import { projectReadDatabase } from "./project-read-database.js";

export const isWorktreeCleanupEnabled = (setting: WorktreeCleanup): boolean =>
	setting.onSettle !== "off" ||
	setting.onDelete ||
	setting.afterInactiveDays !== null ||
	setting.whenMerged ||
	setting.noCommitsBeyondDefault;

/** Read only: a cold relay is needed only when a persisted candidate could match. */
export const readColdWorktreeCleanupCandidates = (
	project: Pick<StoredProject, "slug" | "folders">,
	configDir: string,
	setting: WorktreeCleanup,
	now: number,
) =>
	Effect.gen(function* () {
		if (!isWorktreeCleanupEnabled(setting)) return [];
		const database = yield* projectReadDatabase(project, configDir);
		if (Option.isNone(database)) return [];
		const paths = yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* sql<{ session_id: string; path: string }>`
			WITH latest_turns AS (
				SELECT session_id, requested_at, started_at, completed_at,
					ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY requested_at DESC, rowid DESC) AS rank
				FROM turns
			)
			SELECT DISTINCT events.session_id, mapping.value AS path
			FROM events, json_each(events.data, '$.worktrees') AS mapping
			LEFT JOIN sessions ON sessions.id = events.session_id
			LEFT JOIN latest_turns ON latest_turns.session_id = sessions.id AND latest_turns.rank = 1
			WHERE events.project_id = ${project.slug}
				AND events.type = 'session.workspace_changed'
				AND json_extract(events.data, '$.cause') = 'launch'
				AND json_extract(events.data, '$.origin') = 'conduit'
				AND (
					(sessions.id IS NULL AND ${Number(setting.onDelete)} = 1)
					OR (sessions.id IS NOT NULL AND (
						(${Number(setting.onSettle !== "off")} = 1 AND sessions.settled_at IS NOT NULL)
						OR ${Number(setting.whenMerged || setting.noCommitsBeyondDefault)} = 1
						OR (${Number(setting.afterInactiveDays !== null)} = 1 AND (
							SELECT MAX(activity_at) FROM (
								SELECT sessions.last_message_at AS activity_at
								UNION ALL SELECT MAX(created_at) FROM messages WHERE session_id = sessions.id AND role = 'user'
								UNION ALL SELECT latest_turns.requested_at
								UNION ALL SELECT latest_turns.started_at
								UNION ALL SELECT latest_turns.completed_at
							)
						) < ${now - (setting.afterInactiveDays ?? 0) * 86_400_000})
					))
				)`;
		}).pipe(Effect.provide(database.value));
		return paths.filter(({ path }) => existsSync(path));
	});
