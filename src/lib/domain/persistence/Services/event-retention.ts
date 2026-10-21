import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { PersistenceProjectTag } from "./persistence-service.js";

export interface DrainReport {
	readonly sessionsFreed: number;
	readonly eventsFreed: number;
	/** Logical bytes in the deleted rows' text columns, without page reclamation. */
	readonly bytesFreed: number;
	readonly held: readonly {
		readonly sessionId: string;
		readonly holderSessionIds: readonly string[];
		readonly bound: number;
	}[];
	readonly orphans: readonly string[];
	readonly pointerKept: number;
}

export class EventRetentionTag extends Context.Service<
	EventRetentionTag,
	{ readonly drain: () => Effect.Effect<DrainReport, SqlError> }
>()("EventRetention") {}

// Separate branches preserve the partial expression indexes' exact predicates.
// json_valid keeps malformed rows out of the indexes (json_extract would throw on
// them); replay cannot read such a row as naming S, so it cannot hold S either.
export const EVENT_RETENTION_HOLD_SQL = `
	SELECT session_id AS holder_session_id, MAX(sequence) AS bound FROM (
		SELECT session_id, sequence FROM events
		WHERE project_id = ? AND type IN ('session.created', 'session.forked')
			AND json_valid(data) AND json_extract(data, '$.parentId') = ? AND session_id <> ?
		UNION ALL
		SELECT session_id, sequence FROM events
		WHERE project_id = ? AND type = 'session.created'
			AND json_valid(data) AND json_extract(data, '$.forkedFrom') = ? AND session_id <> ?
	) GROUP BY session_id ORDER BY session_id`;

export const makeEventRetention = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const { projectId } = yield* PersistenceProjectTag;
	// Match cleanup discovery and readSessionWorktreeOwnership, including the
	// launches that validate subsequent branch renames. These are not lineage holds.
	const keptEvent = sql.literal(`(
		(type = 'session.deleted' AND json_extract(data, '$.sessionId') IS session_id)
		OR (type = 'session.workspace_changed' AND (
			(json_extract(data, '$.cause') IS 'launch' AND json_extract(data, '$.origin') IS 'conduit')
			OR json_extract(data, '$.cause') IS 'branch-rename'
		))
	)`);

	const candidates = () => sql<{ session_id: string }>`
		SELECT DISTINCT marker.session_id FROM events marker
		WHERE marker.project_id = ${projectId} AND marker.type = 'session.deleted'
			AND json_extract(marker.data, '$.sessionId') = marker.session_id
			AND NOT EXISTS (SELECT 1 FROM sessions WHERE id = marker.session_id)
			AND EXISTS (
				SELECT 1 FROM events other
				WHERE other.project_id = ${projectId} AND other.session_id = marker.session_id
					AND NOT ${keptEvent}
			) ORDER BY marker.session_id`;
	const holders = (sessionId: string) =>
		sql.unsafe<{ holder_session_id: string; bound: number }>(
			EVENT_RETENTION_HOLD_SQL,
			[projectId, sessionId, sessionId, projectId, sessionId, sessionId],
		);

	const drain = Effect.fn("EventRetention.drain")(function* () {
		const freedSessions = new Set<string>();
		let eventsFreed = 0;
		let bytesFreed = 0;
		let passFreed: number;
		do {
			passFreed = 0;
			for (const { session_id: sessionId } of yield* candidates()) {
				// A held prefix cannot free anything. Avoid taking SQLite's write
				// lock for it on every pass; each real batch still rechecks below.
				const holding = yield* holders(sessionId);
				const bound = Math.max(0, ...holding.map((row) => row.bound));
				const reclaimable = yield* sql`SELECT 1 FROM events e
					WHERE e.project_id = ${projectId} AND e.session_id = ${sessionId}
						AND e.sequence > ${bound}
						AND NOT ${keptEvent}
					LIMIT 1`;
				if (reclaimable.length === 0) continue;
				while (true) {
					const deleted = yield* sql.withTransaction(
						Effect.gen(function* () {
							// Both read-model checks can only block deletion. The marker
							// remains the only positive evidence that this session is dead.
							const eligible = yield* sql`SELECT 1 FROM events
								WHERE project_id = ${projectId} AND session_id = ${sessionId}
									AND type = 'session.deleted'
									AND json_extract(data, '$.sessionId') = session_id
									AND NOT EXISTS (SELECT 1 FROM sessions WHERE id = ${sessionId})
								LIMIT 1`;
							if (eligible.length === 0) return [];
							const holding = yield* holders(sessionId);
							const bound = Math.max(0, ...holding.map((row) => row.bound));
							return yield* sql<{ sequence: number; bytes: number }>`
								DELETE FROM events WHERE project_id = ${projectId} AND session_id = ${sessionId}
									AND sequence IN (
										SELECT e.sequence FROM events e
										WHERE e.project_id = ${projectId} AND e.session_id = ${sessionId}
											AND e.sequence > ${bound}
											AND NOT ${keptEvent}
										AND NOT EXISTS (
											SELECT 1 FROM message_parts part
												JOIN messages message ON message.id = part.message_id
												JOIN sessions live ON live.id = message.session_id
											WHERE part.result_event_seq = e.sequence
											)
										ORDER BY e.sequence DESC LIMIT 500
									)
								RETURNING sequence, length(CAST(event_id AS BLOB))
									+ length(CAST(session_id AS BLOB)) + length(CAST(type AS BLOB))
									+ length(CAST(data AS BLOB)) + length(CAST(metadata AS BLOB))
									+ length(CAST(provider AS BLOB))
									+ COALESCE(length(CAST(project_id AS BLOB)), 0) AS bytes`;
						}),
					);
					if (deleted.length === 0) break;
					freedSessions.add(sessionId);
					passFreed += deleted.length;
					eventsFreed += deleted.length;
					bytesFreed += deleted.reduce((sum, row) => sum + row.bytes, 0);
					yield* Effect.yieldNow;
				}
			}
		} while (passFreed > 0);

		const held: DrainReport["held"][number][] = [];
		let pointerKept = 0;
		for (const { session_id: sessionId } of yield* candidates()) {
			const holding = yield* holders(sessionId);
			const bound = Math.max(0, ...holding.map((row) => row.bound));
			if (holding.length > 0)
				held.push({
					sessionId,
					holderSessionIds: holding.map((row) => row.holder_session_id),
					bound,
				});
			const [pointers] = yield* sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM events e
				WHERE e.project_id = ${projectId} AND e.session_id = ${sessionId}
					AND e.sequence > ${bound}
					AND NOT ${keptEvent}
					AND EXISTS (
						SELECT 1 FROM message_parts part
						JOIN messages message ON message.id = part.message_id
						JOIN sessions live ON live.id = message.session_id
						WHERE part.result_event_seq = e.sequence
					)`;
			pointerKept += pointers?.count ?? 0;
		}
		const orphans = yield* sql<{ session_id: string }>`
			WITH created AS MATERIALIZED (
				SELECT DISTINCT session_id FROM events INDEXED BY idx_events_type
				WHERE type = 'session.created' AND project_id = ${projectId}
			)
			SELECT created.session_id FROM created
			WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = created.session_id)
				AND NOT EXISTS (
					SELECT 1 FROM events marker
					WHERE marker.project_id = ${projectId} AND marker.session_id = created.session_id
						AND marker.type = 'session.deleted'
						AND json_extract(marker.data, '$.sessionId') = marker.session_id
				) ORDER BY created.session_id`;
		const [freed] = yield* sql<{ count: number }>`
			SELECT COUNT(*) AS count FROM json_each(${JSON.stringify([...freedSessions])}) touched
			WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = touched.value)
				AND EXISTS (
					SELECT 1 FROM events marker
					WHERE marker.project_id = ${projectId} AND marker.session_id = touched.value
						AND marker.type = 'session.deleted'
						AND json_extract(marker.data, '$.sessionId') = marker.session_id
				)
				AND NOT EXISTS (
					SELECT 1 FROM events other
					WHERE other.project_id = ${projectId} AND other.session_id = touched.value
						AND NOT ${keptEvent}
				)`;
		return {
			sessionsFreed: freed?.count ?? 0,
			eventsFreed,
			bytesFreed,
			held,
			orphans: orphans.map((row) => row.session_id),
			pointerKept,
		};
	});
	return { drain };
});

export const EventRetentionLive = Layer.effect(
	EventRetentionTag,
	makeEventRetention,
);
