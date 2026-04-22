import type { SqliteClient } from "./sqlite-client.js";

export interface Migration {
	readonly id: number;
	readonly name: string;
	readonly up: (db: SqliteClient) => void;
}

interface AppliedMigration {
	readonly id: number;
	readonly name: string;
}

function ensureMigrationsTable(db: SqliteClient): void {
	db.execute(`
		CREATE TABLE IF NOT EXISTS _migrations (
			id          INTEGER PRIMARY KEY,
			name        TEXT    NOT NULL,
			applied_at  INTEGER NOT NULL
		)
	`);
}

export function runMigrations(
	db: SqliteClient,
	migrations: readonly Migration[],
): AppliedMigration[] {
	ensureMigrationsTable(db);

	const latest = db.queryOne<{ max_id: number | null }>(
		"SELECT MAX(id) as max_id FROM _migrations",
	);
	const lastApplied = latest?.max_id ?? 0;

	const pending = [...migrations]
		.sort((a, b) => a.id - b.id)
		.filter((m) => m.id > lastApplied);

	const applied: AppliedMigration[] = [];

	for (const migration of pending) {
		db.runInTransaction(() => {
			migration.up(db);
			db.execute(
				"INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)",
				[migration.id, migration.name, Date.now()],
			);
		});
		applied.push({ id: migration.id, name: migration.name });
	}

	return applied;
}
