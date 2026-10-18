// Failure modes: the writer ignores its connection profile, maintenance never
// revisits new indexes, or close optimization runs after the driver has closed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { it } from "@effect/vitest";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";

it.effect(
	"maintains a file-backed writer at open, periodically and before close",
	() =>
		Effect.gen(function* () {
			const directory = yield* Effect.acquireRelease(
				Effect.sync(() =>
					mkdtempSync(join(tmpdir(), "conduit-sqlite-profile-")),
				),
				(directory) =>
					Effect.sync(() =>
						rmSync(directory, { recursive: true, force: true }),
					),
			);
			const filename = join(directory, "events.db");
			yield* Effect.scoped(
				makeEffectSqlMigrator().pipe(
					Effect.provide(SqliteClient.layer({ filename })),
				),
			);
			const seed = new Database(filename);
			try {
				seed.exec(`CREATE TABLE startup_probe (value INTEGER);
				CREATE INDEX startup_value ON startup_probe(value);
				WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM n WHERE value < 2000)
				INSERT INTO startup_probe SELECT value FROM n`);
			} finally {
				seed.close();
			}

			yield* Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					expect(yield* sql`PRAGMA mmap_size`).toEqual([
						{ mmap_size: 1073741824 },
					]);
					expect(yield* sql`PRAGMA analysis_limit`).toEqual([
						{ analysis_limit: 400 },
					]);
					expect(
						yield* sql`SELECT idx FROM sqlite_stat1 WHERE tbl = 'startup_probe'`,
					).toEqual([{ idx: "startup_value" }]);

					yield* sql`CREATE TABLE periodic_probe (value INTEGER)`;
					yield* sql`CREATE INDEX periodic_value ON periodic_probe(value)`;
					yield* sql`INSERT INTO periodic_probe SELECT value FROM startup_probe`;
					yield* sql`SELECT value FROM periodic_probe WHERE value = 100`;
					expect(
						yield* sql`SELECT idx FROM sqlite_stat1 WHERE tbl = 'periodic_probe'`,
					).toEqual([]);
					yield* TestClock.adjust("6 hours");
					expect(
						yield* sql`SELECT idx FROM sqlite_stat1 WHERE tbl = 'periodic_probe'`,
					).toEqual([{ idx: "periodic_value" }]);
					expect(yield* sql`PRAGMA analysis_limit`).toEqual([
						{ analysis_limit: 400 },
					]);

					yield* sql`CREATE TABLE closing_probe (value INTEGER)`;
					yield* sql`CREATE INDEX closing_value ON closing_probe(value)`;
					yield* sql`INSERT INTO closing_probe SELECT value FROM startup_probe`;
					yield* sql`SELECT value FROM closing_probe WHERE value = 100`;
					expect(
						yield* sql`SELECT idx FROM sqlite_stat1 WHERE tbl = 'closing_probe'`,
					).toEqual([]);
				}).pipe(
					Effect.provide(makePersistenceEffectLayer(filename, "test-project")),
				),
			);
			const reopened = new Database(filename, { readonly: true });
			try {
				expect(
					reopened
						.prepare("SELECT idx FROM sqlite_stat1 WHERE tbl = 'closing_probe'")
						.all(),
				).toEqual([{ idx: "closing_value" }]);
			} finally {
				reopened.close();
			}
		}),
);
