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
					{ migration_id: 2, name: "add_message_part_metadata" },
					{ migration_id: 3, name: "add_durable_provider_commands" },
					{ migration_id: 4, name: "drop_events_session_fk" },
					{ migration_id: 5, name: "message_parts_file_type" },
					{ migration_id: 6, name: "message_parts_compaction_type" },
					{ migration_id: 7, name: "messages_context_window" },
					{ migration_id: 8, name: "turn_model_execution" },
					{ migration_id: 9, name: "sessions_permission_mode" },
					{ migration_id: 10, name: "purge_legacy_skeleton_sessions" },
				]);

				const legacyRows = yield* sql<{ id: number; name: string }>`
				SELECT id, name FROM _migrations ORDER BY id`;
				expect(legacyRows).toEqual([
					{ id: 1, name: "create_event_store_tables" },
					{ id: 2, name: "add_message_part_metadata" },
					{ id: 3, name: "add_durable_provider_commands" },
					{ id: 4, name: "drop_events_session_fk" },
					{ id: 5, name: "message_parts_file_type" },
					{ id: 6, name: "message_parts_compaction_type" },
					{ id: 7, name: "messages_context_window" },
					{ id: 8, name: "turn_model_execution" },
					{ id: 9, name: "sessions_permission_mode" },
				]);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) => runMigrations(db, schemaMigrations)),
					),
				),
			),
	);

	it.effect(
		"adopts and upgrades a migration-7 database with turn model execution",
		() =>
			Effect.gen(function* () {
				const completed = yield* makeEffectSqlMigrator();
				expect(completed).toEqual([
					[1, "create_event_store_tables"],
					[2, "add_message_part_metadata"],
					[3, "add_durable_provider_commands"],
					[4, "drop_events_session_fk"],
					[5, "message_parts_file_type"],
					[6, "message_parts_compaction_type"],
					[7, "messages_context_window"],
					[8, "turn_model_execution"],
					[9, "sessions_permission_mode"],
					[10, "purge_legacy_skeleton_sessions"],
				]);

				const sql = yield* SqlClient.SqlClient;
				const columns = yield* sql<{ name: string }>`PRAGMA table_info(turns)`;
				expect(columns.map((column) => column.name)).toEqual(
					expect.arrayContaining([
						"requested_model",
						"expected_model",
						"actual_model",
					]),
				);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);

				const effectHistory = yield* sql<{
					migration_id: number;
					name: string;
				}>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(effectHistory.at(-1)).toEqual({
					migration_id: 10,
					name: "purge_legacy_skeleton_sessions",
				});
				const legacyHistory = yield* sql<{ id: number; name: string }>`
					SELECT id, name FROM _migrations ORDER BY id`;
				expect(legacyHistory.at(-1)).toEqual({
					id: 7,
					name: "messages_context_window",
				});
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) =>
							runMigrations(db, schemaMigrations.slice(0, 7)),
						),
					),
				),
			),
	);

	it.effect(
		"adopts an old baseline schema and adds message part metadata",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();

				const sql = yield* SqlClient.SqlClient;
				const migrationRows = yield* sql<{
					migration_id: number;
					name: string;
				}>`
				SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(migrationRows).toEqual([
					{ migration_id: 1, name: "create_event_store_tables" },
					{ migration_id: 2, name: "add_message_part_metadata" },
					{ migration_id: 3, name: "add_durable_provider_commands" },
					{ migration_id: 4, name: "drop_events_session_fk" },
					{ migration_id: 5, name: "message_parts_file_type" },
					{ migration_id: 6, name: "message_parts_compaction_type" },
					{ migration_id: 7, name: "messages_context_window" },
					{ migration_id: 8, name: "turn_model_execution" },
					{ migration_id: 9, name: "sessions_permission_mode" },
					{ migration_id: 10, name: "purge_legacy_skeleton_sessions" },
				]);

				const columns = yield* sql<{ name: string }>`
				PRAGMA table_info(message_parts)`;
				expect(columns.map((column) => column.name)).toContain("metadata");
				const receiptColumns = yield* sql<{ name: string }>`
				PRAGMA table_info(command_receipts)`;
				expect(receiptColumns.map((column) => column.name)).toContain(
					"fingerprint_hash",
				);
				const messageColumns = yield* sql<{ name: string }>`
				PRAGMA table_info(messages)`;
				expect(messageColumns.map((column) => column.name)).toContain(
					"context_window",
				);
				const turnColumns = yield* sql<{ name: string }>`
				PRAGMA table_info(turns)`;
				expect(turnColumns.map((column) => column.name)).toEqual(
					expect.arrayContaining([
						"requested_model",
						"expected_model",
						"actual_model",
					]),
				);
				const sessionColumns = yield* sql<{ name: string }>`
				PRAGMA table_info(sessions)`;
				expect(sessionColumns.map((column) => column.name)).toContain(
					"permission_mode",
				);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) => {
							const baseline = schemaMigrations[0];
							if (!baseline) {
								throw new Error("Expected event-store baseline migration");
							}
							runMigrations(db, [baseline]);
						}),
					),
				),
			),
	);

	it.effect(
		"adds the sessions permission mode column to a migration-8 database",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();

				const sql = yield* SqlClient.SqlClient;
				const columns = yield* sql<{ name: string }>`
					PRAGMA table_info(sessions)`;
				expect(columns.map((column) => column.name)).toContain(
					"permission_mode",
				);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) =>
							runMigrations(db, schemaMigrations.slice(0, 8)),
						),
					),
				),
			),
	);

	it.effect(
		"is idempotent when the sessions permission mode column already exists",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();

				const sql = yield* SqlClient.SqlClient;
				const columns = yield* sql<{ name: string }>`
					PRAGMA table_info(sessions)`;
				expect(
					columns.filter((column) => column.name === "permission_mode"),
				).toHaveLength(1);
				const history = yield* sql<{ migration_id: number; name: string }>`
					SELECT migration_id, name
					FROM effect_sql_migrations
					ORDER BY migration_id`;
				expect(history.at(-1)).toEqual({
					migration_id: 10,
					name: "purge_legacy_skeleton_sessions",
				});
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) => {
							runMigrations(db, schemaMigrations.slice(0, 8));
							db.execute(
								"ALTER TABLE sessions ADD COLUMN permission_mode TEXT",
							);
						}),
					),
				),
			),
	);
});
