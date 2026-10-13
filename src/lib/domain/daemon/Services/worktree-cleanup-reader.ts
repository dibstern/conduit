import { existsSync, statSync } from "node:fs";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Either, Layer } from "effect";
import type { WorktreeCleanup } from "../../../contracts/worktree.js";
import { projectEventsDbPath } from "../../../persistence/project-storage.js";
import type { StoredProject } from "../../../types.js";

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
		const filename = projectEventsDbPath({ configDir, ...project });
		const databaseStat = yield* Effect.either(
			Effect.try({
				try: () => statSync(filename),
				catch: (cause) => cause,
			}),
		);
		if (Either.isLeft(databaseStat)) {
			const cause = databaseStat.left;
			if (
				typeof cause === "object" &&
				cause !== null &&
				"code" in cause &&
				cause.code === "ENOENT"
			)
				return [];
			return yield* Effect.fail(cause);
		}
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
			WHERE events.type = 'session.workspace_changed'
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
		}).pipe(
			Effect.provide(
				SqliteNode.layer({ filename, readonly: true, disableWAL: true }).pipe(
					Layer.provide(Reactivity.layer),
				),
			),
		);
		return paths.filter(({ path }) => existsSync(path));
	});
