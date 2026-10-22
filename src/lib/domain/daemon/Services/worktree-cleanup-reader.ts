import { existsSync } from "node:fs";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { WorktreeCleanup } from "../../../contracts/worktree.js";
import { WORKTREE_CLEANUP_PATHS_SQL } from "../../../persistence/effect/session-worktree-ownership.js";
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
			SELECT paths.session_id, paths.path
			FROM (${sql.unsafe(WORKTREE_CLEANUP_PATHS_SQL, [project.slug])}) AS paths
			LEFT JOIN sessions ON sessions.id = paths.session_id
			WHERE (sessions.id IS NULL AND ${Number(filter.lifecycleStates.includes("deleted"))} = 1)
					OR (${Number(filter.lifecycleStates.includes("settled"))} = 1
						AND sessions.settled_at IS NOT NULL
						AND (${filter.latestSettledAt} IS NULL OR sessions.settled_at <= ${filter.latestSettledAt}))`;
		}).pipe(Effect.provide(database));
		return paths.filter(({ path }) => existsSync(path));
	});
