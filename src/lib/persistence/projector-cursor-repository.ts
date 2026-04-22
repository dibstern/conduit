// src/lib/persistence/projector-cursor-repository.ts

import type { SqliteClient } from "./sqlite-client.js";

export interface ProjectorCursor {
	readonly projectorName: string;
	readonly lastAppliedSeq: number;
	readonly updatedAt: number;
}

interface CursorRow {
	projector_name: string;
	last_applied_seq: number;
	updated_at: number;
}

export class ProjectorCursorRepository {
	constructor(private readonly db: SqliteClient) {}

	get(projectorName: string): ProjectorCursor | undefined {
		const row = this.db.queryOne<CursorRow>(
			"SELECT projector_name, last_applied_seq, updated_at FROM projector_cursors WHERE projector_name = ?",
			[projectorName],
		);
		if (!row) return undefined;
		return {
			projectorName: row.projector_name,
			lastAppliedSeq: row.last_applied_seq,
			updatedAt: row.updated_at,
		};
	}

	listAll(): readonly ProjectorCursor[] {
		return this.db
			.query<CursorRow>(
				"SELECT projector_name, last_applied_seq, updated_at FROM projector_cursors ORDER BY projector_name ASC",
			)
			.map((row) => ({
				projectorName: row.projector_name,
				lastAppliedSeq: row.last_applied_seq,
				updatedAt: row.updated_at,
			}));
	}

	upsert(projectorName: string, lastAppliedSeq: number): void {
		this.db.execute(
			`INSERT INTO projector_cursors (projector_name, last_applied_seq, updated_at) VALUES (?, ?, ?)
			ON CONFLICT (projector_name) DO UPDATE SET
				last_applied_seq = MAX(excluded.last_applied_seq, projector_cursors.last_applied_seq),
				updated_at = CASE WHEN excluded.last_applied_seq > projector_cursors.last_applied_seq
					THEN excluded.updated_at ELSE projector_cursors.updated_at END`,
			[projectorName, lastAppliedSeq, Date.now()],
		);
	}

	minCursor(): number {
		const row = this.db.queryOne<{ min_seq: number | null }>(
			"SELECT MIN(last_applied_seq) AS min_seq FROM projector_cursors",
		);
		return row?.min_seq ?? 0;
	}
}
