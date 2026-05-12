import { createHash } from "node:crypto";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect } from "effect";
import { SqliteClient } from "./sqlite-client.js";

export interface Migration {
	readonly id: number;
	readonly name: string;
	readonly sql: string;
}

export interface AppliedMigration {
	readonly id: number;
	readonly name: string;
	readonly checksum: string;
}

interface AppliedMigrationRow {
	readonly id: number;
	readonly name: string;
	readonly checksum: string | null;
	readonly applied_at: number;
}

interface MigrationValidation {
	readonly lastApplied: number;
	readonly legacyChecksumBackfills: readonly AppliedMigration[];
}

interface SchemaObjectRow {
	readonly type: "table" | "index";
	readonly name: string;
	readonly tbl_name: string;
	readonly sql: string | null;
}

export class MigrationError extends Error {
	readonly _tag = "MigrationError";
	readonly cause: unknown;

	constructor(args: { readonly reason: string; readonly cause?: unknown }) {
		super(args.reason);
		this.name = "MigrationError";
		this.cause = args.cause;
	}
}

const MIGRATIONS_TABLE = "_migrations";

export function calculateMigrationChecksum(migration: Migration): string {
	return createHash("sha256").update(migration.sql).digest("hex");
}

function createMigrationsTableSql(): string {
	return `
		CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
			id          INTEGER PRIMARY KEY,
			name        TEXT    NOT NULL,
			checksum    TEXT    NOT NULL,
			applied_at  INTEGER NOT NULL
		)
	`;
}

function normalizeMigrations(
	migrations: readonly Migration[],
): readonly Migration[] {
	const sorted = [...migrations].sort((a, b) => a.id - b.id);
	const seenIds = new Set<number>();
	const seenNames = new Set<string>();

	for (const migration of sorted) {
		if (!Number.isInteger(migration.id) || migration.id <= 0) {
			throw new MigrationError({
				reason: `Migration id must be a positive integer: ${migration.id}`,
			});
		}
		if (migration.name.trim() === "") {
			throw new MigrationError({
				reason: `Migration ${migration.id} has an empty name`,
			});
		}
		if (migration.sql.trim() === "") {
			throw new MigrationError({
				reason: `Migration ${migration.id} (${migration.name}) has empty SQL`,
			});
		}
		if (seenIds.has(migration.id)) {
			throw new MigrationError({
				reason: `Duplicate migration id: ${migration.id}`,
			});
		}
		if (seenNames.has(migration.name)) {
			throw new MigrationError({
				reason: `Duplicate migration name: ${migration.name}`,
			});
		}
		seenIds.add(migration.id);
		seenNames.add(migration.name);
	}

	for (const [index, migration] of sorted.entries()) {
		const expectedId = index + 1;
		if (migration.id !== expectedId) {
			throw new MigrationError({
				reason: `Migration ids must be contiguous starting at 1: expected ${expectedId}, got ${migration.id} (${migration.name})`,
			});
		}
	}

	return sorted;
}

function ensureMigrationsTable(db: SqliteClient): void {
	db.execute(createMigrationsTableSql());
	const columns = db.query<{ name: string }>(
		`PRAGMA table_info(${MIGRATIONS_TABLE})`,
	);
	if (!columns.some((column) => column.name === "checksum")) {
		db.execute(
			`ALTER TABLE ${MIGRATIONS_TABLE} ADD COLUMN checksum TEXT NOT NULL DEFAULT ''`,
		);
	}
}

function validateAppliedRows(
	rows: readonly AppliedMigrationRow[],
	migrations: readonly Migration[],
): MigrationValidation {
	const migrationsById = new Map(
		migrations.map((migration) => [migration.id, migration]),
	);
	const appliedIds = new Set<number>();
	const legacyChecksumBackfills: AppliedMigration[] = [];
	let lastApplied = 0;

	for (const row of rows) {
		lastApplied = Math.max(lastApplied, row.id);
		appliedIds.add(row.id);

		const migration = migrationsById.get(row.id);
		if (!migration) {
			throw new MigrationError({
				reason: `Applied migration ${row.id} (${row.name}) no longer exists`,
			});
		}
		if (migration.name !== row.name) {
			throw new MigrationError({
				reason: `Applied migration ${row.id} name mismatch: database has "${row.name}", code has "${migration.name}"`,
			});
		}

		const checksum = calculateMigrationChecksum(migration);
		if (!row.checksum) {
			legacyChecksumBackfills.push({
				id: migration.id,
				name: migration.name,
				checksum,
			});
			continue;
		}
		if (row.checksum !== checksum) {
			throw new MigrationError({
				reason: `Applied migration ${row.id} (${row.name}) checksum mismatch`,
			});
		}
	}

	for (const migration of migrations) {
		if (migration.id > lastApplied) break;
		if (!appliedIds.has(migration.id)) {
			throw new MigrationError({
				reason: `Migration history has a gap before ${lastApplied}: missing ${migration.id} (${migration.name})`,
			});
		}
	}

	return { lastApplied, legacyChecksumBackfills };
}

const SCHEMA_OBJECTS_SQL = `
	SELECT type, name, tbl_name, sql
	FROM sqlite_master
	WHERE type IN ('table', 'index')
		AND name NOT LIKE 'sqlite_%'
		AND name != '${MIGRATIONS_TABLE}'
	ORDER BY type, name`;

function normalizeSchemaSql(sql: string | null): string {
	return (sql ?? "").replace(/\s+/g, " ").trim();
}

function schemaObjectKey(row: SchemaObjectRow): string {
	return `${row.type}:${row.name}`;
}

function schemaObjectRows(db: SqliteClient): readonly SchemaObjectRow[] {
	return db.query<SchemaObjectRow>(SCHEMA_OBJECTS_SQL);
}

function schemaObjectMap(
	rows: readonly SchemaObjectRow[],
): ReadonlyMap<string, string> {
	return new Map(
		rows.map((row) => [schemaObjectKey(row), normalizeSchemaSql(row.sql)]),
	);
}

function expectedSchemaObjectsForMigration(
	migration: Migration,
): readonly SchemaObjectRow[] {
	const db = SqliteClient.memory();
	try {
		db.exec(migration.sql);
		return schemaObjectRows(db);
	} finally {
		db.close();
	}
}

function assertLegacyMigrationSchemaPresent(
	actualRows: readonly SchemaObjectRow[],
	migration: Migration,
): void {
	const actualObjects = schemaObjectMap(actualRows);
	for (const expected of expectedSchemaObjectsForMigration(migration)) {
		const key = schemaObjectKey(expected);
		const actualSql = actualObjects.get(key);
		if (actualSql == null) {
			throw new MigrationError({
				reason: `Legacy migration ${migration.id} (${migration.name}) cannot be checksum-backfilled: schema object ${key} is missing`,
			});
		}

		const expectedSql = normalizeSchemaSql(expected.sql);
		if (actualSql !== expectedSql) {
			throw new MigrationError({
				reason: `Legacy migration ${migration.id} (${migration.name}) cannot be checksum-backfilled: schema object ${key} differs from the migration SQL`,
			});
		}
	}
}

function prepareMigrationHistory(
	db: SqliteClient,
	migrations: readonly Migration[],
): MigrationValidation {
	return db.runInTransaction(() => {
		ensureMigrationsTable(db);

		const rows = db.query<AppliedMigrationRow>(
			`SELECT id, name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY id`,
		);
		const migrationsById = new Map(
			migrations.map((migration) => [migration.id, migration]),
		);
		const validation = validateAppliedRows(rows, migrations);

		if (validation.legacyChecksumBackfills.length > 0) {
			const actualSchema = schemaObjectRows(db);
			for (const migration of validation.legacyChecksumBackfills) {
				const sourceMigration = migrationsById.get(migration.id);
				if (sourceMigration) {
					assertLegacyMigrationSchemaPresent(actualSchema, sourceMigration);
				}
			}
		}

		for (const migration of validation.legacyChecksumBackfills) {
			db.execute(`UPDATE ${MIGRATIONS_TABLE} SET checksum = ? WHERE id = ?`, [
				migration.checksum,
				migration.id,
			]);
		}

		return validation;
	});
}

export function runMigrations(
	db: SqliteClient,
	migrations: readonly Migration[],
): AppliedMigration[] {
	const sorted = normalizeMigrations(migrations);
	const { lastApplied } = prepareMigrationHistory(db, sorted);

	const pending = sorted.filter((migration) => migration.id > lastApplied);
	const applied: AppliedMigration[] = [];

	for (const migration of pending) {
		const checksum = calculateMigrationChecksum(migration);
		db.runInTransaction(() => {
			db.exec(migration.sql);
			db.execute(
				`INSERT INTO ${MIGRATIONS_TABLE} (id, name, checksum, applied_at)
				 VALUES (?, ?, ?, ?)`,
				[migration.id, migration.name, checksum, Date.now()],
			);
		});
		applied.push({ id: migration.id, name: migration.name, checksum });
	}

	return applied;
}

export function runMigrationsEffect(
	migrations: readonly Migration[],
): Effect.Effect<
	readonly AppliedMigration[],
	MigrationError,
	SqliteNode.SqliteClient
> {
	return Effect.gen(function* () {
		const sqlite = yield* SqliteNode.SqliteClient;
		if (sqlite.config.filename === ":memory:") {
			return yield* Effect.fail(
				new MigrationError({
					reason:
						"Effect SQL migrations require a file-backed SQLite database; :memory: opens a separate database per connection",
				}),
			);
		}
		if (sqlite.config.readonly === true) {
			return yield* Effect.fail(
				new MigrationError({
					reason:
						"Effect SQL migrations require a writable SQLite database; readonly clients cannot be migrated",
				}),
			);
		}
		return yield* Effect.try({
			try: () => {
				const db = SqliteClient.open(sqlite.config.filename);
				try {
					return runMigrations(db, migrations);
				} finally {
					db.close();
				}
			},
			catch: (cause) =>
				cause instanceof MigrationError
					? cause
					: new MigrationError({
							reason: "Failed to run migrations",
							cause,
						}),
		});
	});
}
