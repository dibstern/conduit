import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import {
	type AutoDeleteArchivedFacts,
	shouldDeleteArchivedSessionTree,
} from "./auto-archive-policy.js";

/** Follow parent_id, including side threads and subagents, rather than cached root_id. */
export const readPersistedAutoDeleteFacts = (projectId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{
			root_id: string;
			id: string;
			version: number;
			root_archived_at: number | null;
			pinned_at: number | null;
			pending_work: number;
		}>`
			WITH RECURSIVE tree(root_id, id, root_archived_at) AS (
				SELECT id, id, archived_at FROM sessions WHERE project_id = ${projectId} AND parent_id IS NULL
				UNION
				SELECT tree.root_id, s.id, tree.root_archived_at FROM sessions s JOIN tree ON s.parent_id = tree.id
			)
			SELECT tree.root_id, s.id, s.version, tree.root_archived_at, s.pinned_at,
				(s.status IN ('busy', 'retry', 'running')
					OR EXISTS(SELECT 1 FROM turns t WHERE t.session_id = s.id AND t.state IN ('pending', 'running'))
					OR EXISTS(SELECT 1 FROM pending_approvals a WHERE a.session_id = s.id AND a.status = 'pending')
					OR EXISTS(SELECT 1 FROM pending_inputs i WHERE i.session_id = s.id AND i.state IN ('queued', 'steering'))) AS pending_work
			FROM tree JOIN sessions s ON s.id = tree.id`;
		const trees = new Map<
			string,
			{ sessionVersions: Map<string, number>; facts: AutoDeleteArchivedFacts }
		>();
		for (const row of rows) {
			const tree = trees.get(row.root_id) ?? {
				sessionVersions: new Map<string, number>(),
				facts: {
					rootArchivedAt: row.root_archived_at,
					pinned: false,
					hasPendingWork: false,
					hasLiveBackgroundWork: false,
				},
			};
			tree.sessionVersions.set(row.id, row.version);
			tree.facts = {
				rootArchivedAt: row.root_archived_at,
				pinned: tree.facts.pinned || row.pinned_at !== null,
				hasPendingWork: tree.facts.hasPendingWork || row.pending_work !== 0,
				hasLiveBackgroundWork: false,
			};
			trees.set(row.root_id, tree);
		}
		return trees;
	});

export const deleteArchivedSessions = <DeleteError>(
	ports: {
		readonly hasLiveBackgroundWork: (sessionId: string) => boolean;
		/** The caller serializes eligibility changes and keeps checkouts. */
		readonly deleteSession: (
			sessionId: string,
			sessionVersions: ReadonlyMap<string, number>,
		) => Effect.Effect<boolean, DeleteError>;
	},
	windowMs: number,
	now: number,
) =>
	Effect.gen(function* () {
		const { projectId } = yield* PersistenceProjectTag;
		const trees = yield* readPersistedAutoDeleteFacts(projectId);
		let deleted = 0;
		let attempted = 0;
		for (const [rootId, { sessionVersions, facts }] of trees) {
			const sessionIds = [...sessionVersions.keys()];
			if (
				!shouldDeleteArchivedSessionTree(
					{
						...facts,
						hasLiveBackgroundWork: sessionIds.some(ports.hasLiveBackgroundWork),
					},
					now,
					windowMs,
				)
			)
				continue;
			if (attempted++ === 50) break;
			if (!(yield* ports.deleteSession(rootId, sessionVersions))) continue;
			deleted++;
		}
		return deleted;
	});
