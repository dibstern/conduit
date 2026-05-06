// ─── Effect-based Projector Cursor Repository ──────────────────────────────
// Migrates projector-cursor-repository.ts from raw SqliteClient to @effect/sql.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";

// ─── Error type ─────────────────────────────────────────────────────────────

export class CursorError extends Data.TaggedError("CursorError")<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

// ─── Domain types ───────────────────────────────────────────────────────────

export interface ProjectorCursor {
	readonly projectorName: string;
	readonly lastAppliedSeq: number;
	readonly updatedAt: number;
}

interface CursorRow {
	readonly projector_name: string;
	readonly last_applied_seq: number;
	readonly updated_at: number;
}

// ─── Service interface ──────────────────────────────────────────────────────

export interface ProjectorCursorEffect {
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

// ─── Service Tag ────────────────────────────────────���───────────────────────

export class ProjectorCursorEffectTag extends Context.Tag(
	"ProjectorCursorEffect",
)<ProjectorCursorEffectTag, ProjectorCursorEffect>() {}

// ─── Row conversion ─────────────────────────────────────────────────────────

function rowToCursor(row: CursorRow): ProjectorCursor {
	return {
		projectorName: row.projector_name,
		lastAppliedSeq: row.last_applied_seq,
		updatedAt: row.updated_at,
	};
}

// ─── Service implementation ─────────────────────────────────────────────────

export const makeProjectorCursorEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	const get = (
		projectorName: string,
	): Effect.Effect<ProjectorCursor | undefined, CursorError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<CursorRow>`
				SELECT projector_name, last_applied_seq, updated_at
				FROM projector_cursors
				WHERE projector_name = ${projectorName}`;
			const row = rows[0];
			return row ? rowToCursor(row) : undefined;
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
			return rows.map(rowToCursor);
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

	return { get, listAll, upsert, minCursor } satisfies ProjectorCursorEffect;
});
