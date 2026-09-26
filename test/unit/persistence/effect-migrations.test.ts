import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import Database from "better-sqlite3";
import { Effect, Exit, Layer } from "effect";
import { expect } from "vitest";
import {
	makeEffectMigrationLoader,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import type { SessionRow } from "../../../src/lib/persistence/read-model-types.js";
import { sessionRowsToSessionInfoList } from "../../../src/lib/persistence/session-list-adapter.js";
import { seedLegacyEventStore } from "../../helpers/legacy-event-store.js";

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

function seedDatabase(filename: string, seed: (db: Database.Database) => void) {
	const db = new Database(filename);
	try {
		seed(db);
	} finally {
		db.close();
	}
}

// After the legacy skeleton cutoff, so migration 10's purge keeps these sessions.
const CREATED_AT = 2_000_000_000_000;
const ACTIVE_AT = CREATED_AT + 456;

function sessionColumns(db: Database.Database): string[] {
	return db
		.prepare<unknown[], { name: string }>("PRAGMA table_info(sessions)")
		.all()
		.map((column) => column.name);
}

describe("Effect SQL migrations", () => {
	it.effect("adds automatic settlement columns with nullable overrides", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* makeEffectSqlMigrator();
			const columns = yield* sql.unsafe<{ name: string }>(
				"PRAGMA table_info(sessions)",
			);
			expect(columns.map((column) => column.name)).toEqual(
				expect.arrayContaining([
					"unsettled_at",
					"auto_settle_disabled_at",
					"settled_automatically",
				]),
			);
			yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES ('auto-s1', 'opencode', 'Auto', 'idle', 1, 1)`;
			const rows = yield* sql<{
				unsettled_at: number | null;
				auto_settle_disabled_at: number | null;
				settled_automatically: number;
			}>`
				SELECT unsettled_at, auto_settle_disabled_at, settled_automatically FROM sessions WHERE id = 'auto-s1'`;
			expect(rows[0]).toEqual({
				unsettled_at: null,
				auto_settle_disabled_at: null,
				settled_automatically: 0,
			});
			expect(yield* makeEffectSqlMigrator()).toEqual([]);
		}).pipe(Effect.provide(makeFileSqlLayer())),
	);
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

	it.effect("runs migrations in key order", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const completed = yield* makeEffectSqlMigrator({
				"0002_seed_users": sql`INSERT INTO users (name) VALUES ('ada')`,
				"0001_create_users": sql`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)`,
			});
			expect(completed).toEqual([
				[1, "create_users"],
				[2, "seed_users"],
			]);
			expect(yield* sql`SELECT name FROM users`).toEqual([{ name: "ada" }]);
		}).pipe(Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" }))),
	);

	it.effect("runs only the migrations added since the last run", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const createUsers = sql`CREATE TABLE users (id INTEGER PRIMARY KEY)`;
			yield* makeEffectSqlMigrator({ "0001_create_users": createUsers });

			const completed = yield* makeEffectSqlMigrator({
				"0001_create_users": createUsers,
				"0002_create_posts": sql`CREATE TABLE posts (id INTEGER PRIMARY KEY)`,
			});
			expect(completed).toEqual([[2, "create_posts"]]);
		}).pipe(Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" }))),
	);

	it.effect("a failed migration run applies and records nothing", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const createGood = sql`CREATE TABLE good_table (id INTEGER PRIMARY KEY)`;
			const failed = yield* Effect.exit(
				makeEffectSqlMigrator({
					"0001_good": createGood,
					"0002_bad": sql.unsafe(
						"CREATE TABLE broken_table (id INTEGER PRIMARY KEY",
					),
				}),
			);
			expect(Exit.isFailure(failed)).toBe(true);
			expect(
				yield* sql`SELECT name FROM sqlite_master WHERE name = 'good_table'`,
			).toEqual([]);

			// Nothing was recorded, so a fixed run starts again from the first migration.
			expect(
				yield* makeEffectSqlMigrator({
					"0001_good": createGood,
					"0002_fixed": sql`CREATE TABLE fixed_table (id INTEGER PRIMARY KEY)`,
				}),
			).toEqual([
				[1, "good"],
				[2, "fixed"],
			]);
		}).pipe(Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" }))),
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
					{ migration_id: 11, name: "session_cascade_deletes" },
					{ migration_id: 12, name: "sessions_read_at" },
					{ migration_id: 13, name: "sessions_last_turn_error" },
					{ migration_id: 14, name: "backfill_compaction_messages" },
					{ migration_id: 15, name: "sessions_settled_pinned" },
					{ migration_id: 16, name: "sessions_snoozed" },
					{ migration_id: 17, name: "sessions_auto_settle" },
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
					{ id: 10, name: "session_cascade_deletes" },
					{ id: 11, name: "sessions_read_at" },
					{ id: 12, name: "sessions_last_turn_error" },
					{ id: 13, name: "backfill_compaction_messages" },
				]);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) => seedLegacyEventStore(db)),
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
					[11, "session_cascade_deletes"],
					[12, "sessions_read_at"],
					[13, "sessions_last_turn_error"],
					[14, "backfill_compaction_messages"],
					[15, "sessions_settled_pinned"],
					[16, "sessions_snoozed"],
					[17, "sessions_auto_settle"],
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
					migration_id: 17,
					name: "sessions_auto_settle",
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
						seedDatabase(filename, (db) => seedLegacyEventStore(db, 7)),
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
					{ migration_id: 11, name: "session_cascade_deletes" },
					{ migration_id: 12, name: "sessions_read_at" },
					{ migration_id: 13, name: "sessions_last_turn_error" },
					{ migration_id: 14, name: "backfill_compaction_messages" },
					{ migration_id: 15, name: "sessions_settled_pinned" },
					{ migration_id: 16, name: "sessions_snoozed" },
					{ migration_id: 17, name: "sessions_auto_settle" },
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
						seedDatabase(filename, (db) => seedLegacyEventStore(db, 1)),
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
						seedDatabase(filename, (db) => seedLegacyEventStore(db, 8)),
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
					migration_id: 17,
					name: "sessions_auto_settle",
				});
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) => {
							seedLegacyEventStore(db, 8);
							db.prepare(
								"ALTER TABLE sessions ADD COLUMN permission_mode TEXT",
							).run();
						}),
					),
				),
			),
	);

	it.effect(
		"adds read_at once and backfills existing sessions as already read",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();

				const sql = yield* SqlClient.SqlClient;
				// The criterion is that upgrading does not invent a backlog, so assert on
				// the derived flag the product actually shows rather than on read_at alone.
				const rows = yield* sql<SessionRow>`SELECT * FROM sessions`;
				expect(rows[0]?.read_at).toBe(ACTIVE_AT);
				expect(sessionRowsToSessionInfoList([...rows])[0]).not.toHaveProperty(
					"unread",
				);

				expect(yield* makeEffectSqlMigrator()).toEqual([]);
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(
					columns.filter((column) => column.name === "read_at"),
				).toHaveLength(1);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) => {
							seedLegacyEventStore(db, 10);
							expect(sessionColumns(db)).not.toContain("read_at");
							// last_message_at matters: without activity a session is never
							// unread, so a row that has none cannot tell a working backfill
							// from a missing one.
							db.prepare(
								`INSERT INTO sessions (id, provider, title, status, last_message_at, created_at, updated_at)
								 VALUES (?, ?, ?, ?, ?, ?, ?)`,
							).run(
								"existing",
								"opencode",
								"Existing",
								"idle",
								ACTIVE_AT,
								CREATED_AT,
								ACTIVE_AT,
							);
						}),
					),
				),
			),
	);

	it.effect(
		"adds settled_at and pinned_at once without backfilling existing sessions",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();

				const sql = yield* SqlClient.SqlClient;
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(
					columns.filter(
						(column) =>
							column.name === "settled_at" || column.name === "pinned_at",
					),
				).toHaveLength(2);
				const rows = yield* sql<{
					settled_at: number | null;
					pinned_at: number | null;
					updated_at: number;
				}>`
					SELECT settled_at, pinned_at, updated_at FROM sessions WHERE id = 'existing'`;
				expect(rows[0]).toEqual({
					settled_at: null,
					pinned_at: null,
					updated_at: 2_000_000_000_000,
				});
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) => {
							seedLegacyEventStore(db, 13);
							expect(sessionColumns(db)).not.toContain("settled_at");
							db.prepare(
								`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
								 VALUES (?, ?, ?, ?, ?, ?)`,
							).run(
								"existing",
								"opencode",
								"Existing",
								"idle",
								2_000_000_000_000,
								2_000_000_000_000,
							);
						}),
					),
				),
			),
	);

	it.effect("adds nullable snooze columns once without backfilling", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			const sql = yield* SqlClient.SqlClient;
			const columns = yield* sql<{ name: string }>`PRAGMA table_info(sessions)`;
			expect(columns.map((column) => column.name)).toEqual(
				expect.arrayContaining([
					"snoozed_at",
					"snoozed_until",
					"woken_at",
					"woken_reason",
				]),
			);
			const rows = yield* sql<{
				snoozed_at: number | null;
				snoozed_until: number | null;
				woken_at: number | null;
				woken_reason: string | null;
				updated_at: number;
			}>`SELECT snoozed_at, snoozed_until, woken_at, woken_reason, updated_at FROM sessions WHERE id = 'existing'`;
			expect(rows[0]).toEqual({
				snoozed_at: null,
				snoozed_until: null,
				woken_at: null,
				woken_reason: null,
				updated_at: CREATED_AT,
			});
			expect(yield* makeEffectSqlMigrator()).toEqual([]);
		}).pipe(
			Effect.provide(
				makeFileSqlLayer((filename) =>
					seedDatabase(filename, (db) => {
						seedLegacyEventStore(db, 13);
						db.prepare(
							`INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
						).run(
							"existing",
							"opencode",
							"Existing",
							"idle",
							CREATED_AT,
							CREATED_AT,
						);
					}),
				),
			),
		),
	);

	it.effect(
		"adds last_turn_error_at once without backfilling historical failures",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();

				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<SessionRow>`SELECT * FROM sessions`;
				expect(rows[0]?.last_turn_error_at).toBeNull();
				expect(sessionRowsToSessionInfoList([...rows])[0]?.attention).toBe(
					"idle",
				);

				expect(yield* makeEffectSqlMigrator()).toEqual([]);
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(
					columns.filter((column) => column.name === "last_turn_error_at"),
				).toHaveLength(1);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) => {
							seedLegacyEventStore(db, 11);
							expect(sessionColumns(db)).not.toContain("last_turn_error_at");
							db.prepare(
								`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
								 VALUES (?, ?, ?, ?, ?, ?)`,
							).run(
								"existing",
								"opencode",
								"Existing",
								"idle",
								CREATED_AT,
								ACTIVE_AT,
							);
						}),
					),
				),
			),
	);
});
