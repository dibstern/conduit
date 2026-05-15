import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
	makeEffectMigrationLoader,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient as SyncSqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

function makeFileSqlLayer(setup?: (filename: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "conduit-effect-migrations-"));
	const filename = join(dir, "events.db");
	setup?.(filename);
	return EffectSqliteClient.layer({ filename }).pipe(
		Layer.merge(
			Layer.scopedDiscard(
				Effect.addFinalizer(() =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			),
		),
	);
}

function seedDatabase(filename: string, seed: (db: SyncSqliteClient) => void) {
	const db = SyncSqliteClient.open(filename);
	try {
		seed(db);
	} finally {
		db.close();
	}
}

describe("Effect SQL migrations", () => {
	it.effect(
		"runs static record migrations once through Effect SQL Migrator",
		() =>
			Effect.gen(function* () {
				const migration = Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
				});
				const migrate = makeEffectSqlMigrator({
					"0001_create_items": migration,
				});

				const completed = yield* migrate;
				expect(completed).toEqual([[1, "create_items"]]);

				const secondRun = yield* migrate;
				expect(secondRun).toEqual([]);

				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<{ migration_id: number; name: string }>`
				SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(rows).toEqual([{ migration_id: 1, name: "create_items" }]);
			}).pipe(
				Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" })),
			),
	);

	it.effect("refuses non-contiguous static migration ids", () =>
		Effect.gen(function* () {
			const result = yield* Effect.either(
				makeEffectMigrationLoader({
					"0002_skip_baseline": Effect.void,
				}),
			);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left.message).toContain("contiguous");
			}
		}),
	);

	it.effect(
		"adopts an existing legacy baseline schema into Effect SQL history",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();

				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<{ migration_id: number; name: string }>`
				SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(rows).toEqual([
					{ migration_id: 1, name: "create_event_store_tables" },
				]);

				const legacyRows = yield* sql<{ id: number; name: string }>`
				SELECT id, name FROM _migrations ORDER BY id`;
				expect(legacyRows).toEqual([
					{ id: 1, name: "create_event_store_tables" },
				]);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) => runMigrations(db, schemaMigrations)),
					),
				),
			),
	);
});
