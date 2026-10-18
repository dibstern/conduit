import { existsSync, statSync } from "node:fs";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Either, Layer } from "effect";
import type { WorktreeCleanup } from "../../../contracts/worktree.js";
import { projectEventsDbPath } from "../../../persistence/project-storage.js";
import { worktreeCleanupCandidateFilter } from "../../../session/worktree-cleanup-rules.js";
import type { StoredProject } from "../../../types.js";

/** Read only: a cold relay is needed only when a persisted candidate could match. */
export const readColdWorktreeCleanupCandidates = (
	project: Pick<StoredProject, "slug" | "folders">,
	configDir: string,
	setting: WorktreeCleanup,
	now: number,
) =>
	Effect.gen(function* () {
		const filter = worktreeCleanupCandidateFilter(setting, now);
		if (filter === undefined) return [];
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
			SELECT DISTINCT events.session_id, mapping.value AS path
			FROM events, json_each(events.data, '$.worktrees') AS mapping
			LEFT JOIN sessions ON sessions.id = events.session_id
			WHERE events.type = 'session.workspace_changed'
				AND json_extract(events.data, '$.cause') = 'launch'
				AND json_extract(events.data, '$.origin') = 'conduit'
				AND (
					(sessions.id IS NULL AND ${Number(filter.lifecycleStates.includes("deleted"))} = 1)
					OR (${Number(filter.lifecycleStates.includes("settled"))} = 1
						AND sessions.settled_at IS NOT NULL
						AND (${filter.latestSettledAt} IS NULL OR sessions.settled_at <= ${filter.latestSettledAt}))
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
