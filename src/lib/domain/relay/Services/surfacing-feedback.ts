import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
	type CategorySetContents,
	countSessionCategories,
	SurfacingFeedbackEntrySchema,
	type SurfacingMark,
	SurfacingMarkSchema,
} from "../../../contracts/category-set.js";
import { WsRpcError } from "../../../contracts/ws-rpc.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";

/** Read every eligible part, independently of the browser's transcript window. */
export const readSessionCategoryCounts = (
	sessionId: string,
	set: CategorySetContents,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{
			surfacing_probabilities: string | null;
			level: string | null;
			category: string | null;
			reason: string | null;
			direction: string | null;
		}>`SELECT mp.surfacing_probabilities, sm.level, sm.category, sm.reason, sm.direction
			FROM message_parts mp JOIN messages m ON m.id = mp.message_id
			LEFT JOIN surfacing_marks sm ON sm.session_id = m.session_id AND sm.part_id = mp.id AND sm.message_id = m.id
			WHERE m.session_id = ${sessionId} AND mp.type = 'text' AND m.role = 'assistant' AND m.turn_id IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM sessions s JOIN messages cut ON cut.id = s.pending_rewind_message_id AND cut.session_id = s.id
				WHERE s.id = m.session_id AND (m.created_at > cut.created_at OR (m.created_at = cut.created_at AND m.id >= cut.id)))
			AND (mp.surfacing_ordinal IS NOT NULL
				OR EXISTS (SELECT 1 FROM message_parts later WHERE later.message_id = m.id AND later.sort_order > mp.sort_order)
				OR EXISTS (SELECT 1 FROM messages later WHERE later.turn_id = m.turn_id AND later.role = 'assistant' AND (later.created_at > m.created_at OR (later.created_at = m.created_at AND later.id > m.id))))`;
		const verdicts = yield* Schema.decodeUnknownEffect(
			Schema.Array(
				Schema.Struct({
					probabilities: Schema.NullOr(
						Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number)),
					),
					mark: Schema.optional(SurfacingMarkSchema),
				}),
			),
		)(
			rows.map((row) => ({
				probabilities: row.surfacing_probabilities,
				...(row.level === null
					? {}
					: {
							mark: {
								level: row.level,
								...(row.category === null ? {} : { category: row.category }),
								...(row.reason === null ? {} : { reason: row.reason }),
								...(row.direction === null ? {} : { direction: row.direction }),
							},
						}),
			})),
		);
		return countSessionCategories(verdicts, set);
	}).pipe(
		Effect.mapError(
			(error) =>
				new WsRpcError({
					message: `Cannot count session categories: ${String(error)}`,
				}),
		),
	);

/** The ledger joins today's immutable verdict; marks never snapshot Jev's answer. */
export const readSurfacingFeedback = (projectId?: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{
			project_id: string;
			session_id: string;
			session_title: string;
			request_excerpt: string;
			part_id: string;
			message_id: string;
			turn_id: string | null;
			surfacing_ordinal: number | null;
			text: string;
			surfacing_probabilities: string | null;
			level: string;
			category: string | null;
			reason: string | null;
			direction: string | null;
			created_at: number;
		}>`SELECT s.project_id, sm.session_id, s.title AS session_title,
			substr(COALESCE(u.text, ''), 1, 1000) AS request_excerpt, sm.part_id, sm.message_id,
			m.turn_id, mp.surfacing_ordinal, substr(COALESCE(mp.text, ''), 1, 2000) AS text, mp.surfacing_probabilities,
			sm.level, sm.category, sm.reason, sm.direction, sm.created_at
			FROM surfacing_marks sm JOIN sessions s ON s.id = sm.session_id
			LEFT JOIN messages m ON m.id = sm.message_id AND m.session_id = sm.session_id
			LEFT JOIN turns t ON t.id = m.turn_id AND t.session_id = m.session_id
			LEFT JOIN messages u ON u.id = t.user_message_id AND u.session_id = m.session_id
			LEFT JOIN message_parts mp ON mp.id = sm.part_id AND mp.message_id = m.id
			WHERE ${projectId === undefined ? sql`1 = 1` : sql`s.project_id = ${projectId}`}
			ORDER BY sm.created_at DESC, sm.part_id`;
		return yield* Schema.decodeUnknownEffect(
			Schema.Array(SurfacingFeedbackEntrySchema),
		)(
			rows.map((row) => ({
				projectId: row.project_id,
				sessionId: row.session_id,
				sessionTitle: row.session_title,
				requestExcerpt: row.request_excerpt,
				partId: row.part_id,
				messageId: row.message_id,
				turnId: row.turn_id,
				ordinal: row.surfacing_ordinal,
				text: row.text,
				probabilities:
					row.surfacing_probabilities === null
						? null
						: JSON.parse(row.surfacing_probabilities),
				mark: {
					level: row.level,
					...(row.category === null ? {} : { category: row.category }),
					...(row.reason === null ? {} : { reason: row.reason }),
					...(row.direction === null ? {} : { direction: row.direction }),
				},
				createdAt: row.created_at,
			})),
		);
	}).pipe(
		Effect.mapError(
			(error) =>
				new WsRpcError({
					message: `Cannot read surfacing feedback: ${String(error)}`,
				}),
		),
	);

/**
 * A fork copies the parent's parts as `<id>_<forkId>` (fork-history.ts); the
 * marks on the parts it kept follow them. Runs inside the fork's commit, after
 * its history is projected.
 */
export const inheritSurfacingMarks = (parentId: string, forkId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO surfacing_marks (part_id, session_id, message_id, level, category, reason, direction, created_at)
			SELECT mp.id, m.session_id, m.id, sm.level, sm.category, sm.reason, sm.direction, sm.created_at
			FROM surfacing_marks sm
			JOIN messages m ON m.id = sm.message_id || '_' || ${forkId} AND m.session_id = ${forkId}
			JOIN message_parts mp ON mp.id = sm.part_id || '_' || ${forkId} AND mp.message_id = m.id
			WHERE sm.session_id = ${parentId}`;
	});

/** Sole annotation writer. A mark changes the part revision, never its verdict. */
export const makeSurfacingFeedback = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const { projectId } = yield* EventStoreEffectTag;
	const commit = yield* makeCommitAndSignal;
	return {
		ledger: () => readSurfacingFeedback(projectId),
		set: (partId: string, mark: SurfacingMark | null) =>
			Effect.gen(function* () {
				const next =
					mark === null
						? null
						: yield* Schema.decodeUnknownEffect(SurfacingMarkSchema)(mark);
				if (next?.direction === "retype" && !next.category)
					return yield* new WsRpcError({
						message: "Retype requires a category",
					});
				const now = yield* Clock.currentTimeMillis;
				yield* commit.write((_project, stamp) =>
					Effect.gen(function* () {
						const [part] = yield* sql<{
							session_id: string;
							message_id: string;
						}>`
						SELECT m.session_id, m.id AS message_id FROM message_parts mp
					JOIN messages m ON m.id = mp.message_id JOIN sessions s ON s.id = m.session_id
					WHERE mp.id = ${partId} AND s.project_id = ${projectId}
					AND mp.type = 'text' AND m.role = 'assistant' AND m.turn_id IS NOT NULL
					AND (mp.surfacing_ordinal IS NOT NULL
						OR EXISTS (SELECT 1 FROM message_parts later WHERE later.message_id = m.id AND later.sort_order > mp.sort_order)
						OR EXISTS (SELECT 1 FROM messages later WHERE later.turn_id = m.turn_id AND later.role = 'assistant' AND (later.created_at > m.created_at OR (later.created_at = m.created_at AND later.id > m.id))))`;
						if (!part)
							return yield* new WsRpcError({
								message: "Unknown mid-turn text part",
							});
						if (next === null)
							yield* sql`DELETE FROM surfacing_marks WHERE session_id = ${part.session_id} AND part_id = ${partId}`;
						else
							yield* sql`INSERT INTO surfacing_marks (part_id, session_id, message_id, level, category, reason, direction, created_at)
					VALUES (${partId}, ${part.session_id}, ${part.message_id}, ${next.level}, ${next.category ?? null}, ${next.reason ?? null}, ${next.direction ?? null}, ${now})
					ON CONFLICT(session_id, part_id) DO UPDATE SET message_id = excluded.message_id, level = excluded.level, category = excluded.category, reason = excluded.reason, direction = excluded.direction, created_at = excluded.created_at`;
						yield* stamp((version) =>
							Effect.gen(function* () {
								yield* sql`UPDATE message_parts SET version = ${version} WHERE id = ${partId}`;
								yield* sql`UPDATE messages SET version = ${version} WHERE id = ${part.message_id}`;
								yield* sql`UPDATE sessions SET version = ${version} WHERE id = ${part.session_id}`;
								return [part.session_id];
							}),
						);
					}),
				);
			}).pipe(
				Effect.mapError((error) =>
					error instanceof WsRpcError
						? error
						: new WsRpcError({
								message: `Cannot save surfacing mark: ${String(error)}`,
							}),
				),
			),
	};
});
