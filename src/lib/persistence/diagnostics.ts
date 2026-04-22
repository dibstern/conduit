// src/lib/persistence/diagnostics.ts
// ─── PersistenceDiagnostics (Task 22.5) ─────────────────────────────────────
// Simple health-check service that queries the event store and read model
// tables for counts, cursor positions, and FK integrity.

import type { SqliteClient } from "./sqlite-client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiagnosticsHealth {
	readonly eventCount: number;
	readonly sessionCount: number;
	readonly projectorCursors: ReadonlyArray<{
		name: string;
		lastAppliedSeq: number;
	}>;
	readonly oldestEventSeq: number | null;
	readonly newestEventSeq: number | null;
}

export interface IntegrityResult {
	readonly ok: boolean;
	readonly errors: readonly string[];
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export class PersistenceDiagnostics {
	constructor(private readonly db: SqliteClient) {}

	/**
	 * Collect high-level health metrics: event count, session count,
	 * projector cursor positions, and event sequence range.
	 */
	health(): DiagnosticsHealth {
		const eventCount =
			this.db.queryOne<{ count: number }>(
				"SELECT COUNT(*) as count FROM events",
			)?.count ?? 0;

		const sessionCount =
			this.db.queryOne<{ count: number }>(
				"SELECT COUNT(*) as count FROM sessions",
			)?.count ?? 0;

		const cursors = this.db
			.query<{ projector_name: string; last_applied_seq: number }>(
				"SELECT projector_name, last_applied_seq FROM projector_cursors ORDER BY projector_name",
			)
			.map((r) => ({
				name: r.projector_name,
				lastAppliedSeq: r.last_applied_seq,
			}));

		const oldest =
			this.db.queryOne<{ seq: number | null }>(
				"SELECT MIN(sequence) as seq FROM events",
			)?.seq ?? null;

		const newest =
			this.db.queryOne<{ seq: number | null }>(
				"SELECT MAX(sequence) as seq FROM events",
			)?.seq ?? null;

		return {
			eventCount,
			sessionCount,
			projectorCursors: cursors,
			oldestEventSeq: oldest,
			newestEventSeq: newest,
		};
	}

	/**
	 * Run SQLite foreign key integrity check.
	 * Returns { ok: true } if no violations, or a list of error strings.
	 */
	checkIntegrity(): IntegrityResult {
		const errors: string[] = [];
		try {
			const fk = this.db.query<{
				table: string;
				rowid: number;
				parent: string;
				fkid: number;
			}>("PRAGMA foreign_key_check");
			if (fk.length > 0) {
				errors.push(`${fk.length} foreign key violation(s)`);
			}
		} catch (e) {
			errors.push(
				`FK check error: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		return { ok: errors.length === 0, errors };
	}
}
