import { existsSync } from "node:fs";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { WorktreeCleanup } from "../../../contracts/worktree.js";
import { worktreeCleanupCandidateFilter } from "../../../session/worktree-cleanup-rules.js";
import type { StoredProject } from "../../../types.js";
import { projectReadDatabase } from "./project-read-database.js";

/** Read only: a cold relay is needed only when a persisted candidate could match. */
export const readColdWorktreeCleanupCandidates = (
	project: Pick<StoredProject, "slug" | "folders">,
	setting: WorktreeCleanup,
	now: number,
) =>
	Effect.gen(function* () {
		const filter = worktreeCleanupCandidateFilter(setting, now);
		if (filter === undefined) return [];
		const database = yield* projectReadDatabase(project);
		const paths = yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* sql<{ session_id: string; path: string }>`
			SELECT DISTINCT events.session_id, mapping.value AS path
			FROM events, json_each(events.data, '$.worktrees') AS mapping
			LEFT JOIN sessions ON sessions.id = events.session_id
			WHERE events.project_id = ${project.slug}
				AND events.type = 'session.workspace_changed'
				AND json_extract(events.data, '$.cause') = 'launch'
				AND json_extract(events.data, '$.origin') = 'conduit'
				AND (
					(sessions.id IS NULL AND ${Number(filter.lifecycleStates.includes("deleted"))} = 1)
					OR (${Number(filter.lifecycleStates.includes("settled"))} = 1
						AND sessions.settled_at IS NOT NULL
						AND (${filter.latestSettledAt} IS NULL OR sessions.settled_at <= ${filter.latestSettledAt}))
				)`;
		}).pipe(Effect.provide(database));
		return paths.filter(({ path }) => existsSync(path));
	});
