// Per-projector sequence cursors, stored in projector_cursors via @effect/sql.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";

export class CursorError extends Data.TaggedError("CursorError")<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export interface ProjectorCursor {
	readonly projectId: string;
	readonly projectorName: string;
	readonly lastAppliedSeq: number;
	readonly updatedAt: number;
}

interface CursorRow {
	readonly projector_name: string;
	readonly last_applied_seq: number;
	readonly updated_at: number;
}

export interface ProjectorCursorEffect {
	readonly projectId: string;
	readonly get: (
		projectorName: string,
	) => Effect.Effect<ProjectorCursor | undefined, CursorError | SqlError>;

	readonly listAll: () => Effect.Effect<
		readonly ProjectorCursor[],
		CursorError | SqlError
	>;

	readonly upsert: (
		projectorName: string,
		lastAppliedSeq: number,
	) => Effect.Effect<void, CursorError | SqlError>;

	readonly minCursor: () => Effect.Effect<number, CursorError | SqlError>;
}

export class ProjectorCursorEffectTag extends Context.Tag(
	"ProjectorCursorEffect",
)<ProjectorCursorEffectTag, ProjectorCursorEffect>() {}

function rowToCursor(row: CursorRow, projectId: string): ProjectorCursor {
	return {
		projectId,
		projectorName: row.projector_name,
		lastAppliedSeq: row.last_applied_seq,
		updatedAt: row.updated_at,
	};
}

export const makeProjectorCursorEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const { projectId } = yield* PersistenceProjectTag;

	const get = (
		projectorName: string,
	): Effect.Effect<ProjectorCursor | undefined, CursorError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<CursorRow>`
				SELECT projector_name, last_applied_seq, updated_at
				FROM projector_cursors
				WHERE projector_name = ${projectorName}`;
			const row = rows[0];
			return row ? rowToCursor(row, projectId) : undefined;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof CursorError
					? e
					: new CursorError({ operation: "get", cause: e }),
			),
		);

	const listAll = (): Effect.Effect<
		readonly ProjectorCursor[],
		CursorError | SqlError
	> =>
		Effect.gen(function* () {
			const rows = yield* sql<CursorRow>`
				SELECT projector_name, last_applied_seq, updated_at
				FROM projector_cursors
				ORDER BY projector_name ASC`;
			return rows.map((row) => rowToCursor(row, projectId));
		}).pipe(
			Effect.mapError((e) =>
				e instanceof CursorError
					? e
					: new CursorError({ operation: "listAll", cause: e }),
			),
		);

	const upsert = (
		projectorName: string,
		lastAppliedSeq: number,
	): Effect.Effect<void, CursorError | SqlError> =>
		Effect.gen(function* () {
			const now = Date.now();
			yield* sql`
				INSERT INTO projector_cursors (projector_name, last_applied_seq, updated_at)
				VALUES (${projectorName}, ${lastAppliedSeq}, ${now})
				ON CONFLICT (projector_name) DO UPDATE SET
					last_applied_seq = MAX(excluded.last_applied_seq, projector_cursors.last_applied_seq),
					updated_at = CASE WHEN excluded.last_applied_seq > projector_cursors.last_applied_seq
						THEN excluded.updated_at ELSE projector_cursors.updated_at END`;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof CursorError
					? e
					: new CursorError({ operation: "upsert", cause: e }),
			),
		);

	const minCursor = (): Effect.Effect<number, CursorError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				min_seq: number | null;
			}>`SELECT MIN(last_applied_seq) AS min_seq FROM projector_cursors`;
			return rows[0]?.min_seq ?? 0;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof CursorError
					? e
					: new CursorError({ operation: "minCursor", cause: e }),
			),
		);

	return {
		projectId,
		get,
		listAll,
		upsert,
		minCursor,
	} satisfies ProjectorCursorEffect;
});
