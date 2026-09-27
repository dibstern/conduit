import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import Database from "better-sqlite3";
import { Effect, Either, Exit, Layer } from "effect";
import { expect } from "vitest";
import {
	effectMigrationEntries,
	makeEffectMigrationLoader,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { seedLegacyEventStore } from "../../helpers/legacy-event-store.js";

function makeFileSqlLayer(seed?: (filename: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "conduit-effect-migrations-"));
	const filename = join(dir, "events.db");
	seed?.(filename);
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

const migrationEntries = Object.entries(effectMigrationEntries);
const prefix = (count: number) =>
	Object.fromEntries(migrationEntries.slice(0, count));

const expectedNames = [
	"create_event_store_tables",
	"add_message_part_metadata",
	"add_durable_provider_commands",
	"drop_events_session_fk",
	"message_parts_file_type",
	"message_parts_compaction_type",
	"messages_context_window",
	"turn_model_execution",
	"sessions_permission_mode",
	"purge_legacy_skeleton_sessions",
	"session_cascade_deletes",
	"sessions_read_at",
	"sessions_last_turn_error",
	"backfill_compaction_messages",
	"sessions_settled_pinned",
	"sessions_snoozed",
	"sessions_auto_settle",
	"create_projection_failures",
	"read_model_version",
	"read_model_counter",
	"sent_alerts",
	"fork_point_timestamp",
];
const legacyNames = [
	"create_event_store_tables",
	"add_message_part_metadata",
	"add_durable_provider_commands",
	"drop_events_session_fk",
	"message_parts_file_type",
	"message_parts_compaction_type",
	"messages_context_window",
	"turn_model_execution",
	"sessions_permission_mode",
	"session_cascade_deletes",
	"sessions_read_at",
	"sessions_last_turn_error",
	"backfill_compaction_messages",
];

describe("Effect migration lineage", () => {
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

	it.effect("refuses non-contiguous static migration ids", () =>
		Effect.gen(function* () {
			const result = yield* Effect.either(
				makeEffectMigrationLoader({ "0002_skip_baseline": Effect.void }),
			);
			expect(Either.isLeft(result)).toBe(true);
			if (Either.isLeft(result))
				expect(result.left.message).toContain("contiguous");
		}),
	);

	it.effect(
		"runs static record migrations once through Effect SQL Migrator",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const entries = {
					"0001_create_items": sql`CREATE TABLE items (id INTEGER PRIMARY KEY)`,
				};
				expect(yield* makeEffectSqlMigrator(entries)).toEqual([
					[1, "create_items"],
				]);
				expect(yield* makeEffectSqlMigrator(entries)).toEqual([]);
				const rows = yield* sql<{ migration_id: number; name: string }>`
				SELECT migration_id, name FROM effect_sql_migrations`;
				expect(rows).toEqual([{ migration_id: 1, name: "create_items" }]);
			}).pipe(
				Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" })),
			),
	);

	it.effect("runs only the migrations added since the last run", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const first = sql`CREATE TABLE users (id INTEGER PRIMARY KEY)`;
			yield* makeEffectSqlMigrator({ "0001_create_users": first });
			expect(
				yield* makeEffectSqlMigrator({
					"0001_create_users": first,
					"0002_create_posts": sql`CREATE TABLE posts (id INTEGER PRIMARY KEY)`,
				}),
			).toEqual([[2, "create_posts"]]);
		}).pipe(Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" }))),
	);

	it.effect(
		"adds read_at once and backfills existing sessions as already read",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(prefix(11));
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, last_message_at, created_at, updated_at)
				VALUES ('existing', 'opencode', 2000000000456, 2000000000000, 2000000000456)`;
				yield* makeEffectSqlMigrator();
				const rows = yield* sql<{ read_at: number; last_message_at: number }>`
				SELECT read_at, last_message_at FROM sessions WHERE id = 'existing'`;
				expect(rows).toEqual([
					{ read_at: 2_000_000_000_456, last_message_at: 2_000_000_000_456 },
				]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(
					columns.filter((column) => column.name === "read_at"),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	for (const [name, count, fields] of [
		["settled and pinned", 14, ["settled_at", "pinned_at"]],
		["snooze", 15, ["snoozed_at", "snoozed_until", "woken_at", "woken_reason"]],
		["automatic settlement", 16, ["unsettled_at", "auto_settle_disabled_at"]],
		["last turn error", 12, ["last_turn_error_at"]],
	] as const) {
		it.effect(
			`adds ${name} columns without backfilling historical sessions`,
			() =>
				Effect.gen(function* () {
					yield* makeEffectSqlMigrator(prefix(count));
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at)
					VALUES ('existing', 'opencode', 2000000000000, 2000000000000)`;
					yield* makeEffectSqlMigrator();
					const rows = yield* sql.unsafe<Record<string, number | null>>(
						`SELECT ${fields.join(", ")} FROM sessions WHERE id = 'existing'`,
					);
					for (const field of fields) expect(rows[0]?.[field]).toBeNull();
					const columns = yield* sql<{
						name: string;
					}>`PRAGMA table_info(sessions)`;
					for (const field of fields)
						expect(
							columns.filter((column) => column.name === field),
						).toHaveLength(1);
					expect(yield* makeEffectSqlMigrator()).toEqual([]);
				}).pipe(Effect.provide(makeFileSqlLayer())),
		);
	}

	for (const legacyId of [1, 7, 8, 9, 13]) {
		it.effect(
			`adopts legacy migration-${legacyId} schema without changing its ledger`,
			() =>
				Effect.gen(function* () {
					const applied = yield* makeEffectSqlMigrator();
					expect(applied).toHaveLength(expectedNames.length);
					const sql = yield* SqlClient.SqlClient;
					const history = yield* sql<{ name: string }>`
					SELECT name FROM effect_sql_migrations ORDER BY migration_id`;
					expect(history.map((row) => row.name)).toEqual(expectedNames);
					const legacy = yield* sql<{
						id: number;
						name: string;
					}>`SELECT id, name FROM _migrations ORDER BY id`;
					expect(legacy).toEqual(
						legacyNames.slice(0, legacyId).map((name, index) => ({
							id: index + 1,
							name,
						})),
					);
					const messagePartColumns = yield* sql<{
						name: string;
					}>`PRAGMA table_info(message_parts)`;
					expect(messagePartColumns.map((row) => row.name)).toContain(
						"metadata",
					);
					const turnColumns = yield* sql<{
						name: string;
					}>`PRAGMA table_info(turns)`;
					expect(turnColumns.map((row) => row.name)).toEqual(
						expect.arrayContaining([
							"requested_model",
							"expected_model",
							"actual_model",
						]),
					);
					const sessionColumns = yield* sql<{
						name: string;
					}>`PRAGMA table_info(sessions)`;
					expect(sessionColumns.map((row) => row.name)).toContain(
						"permission_mode",
					);
					const projectionFailureColumns = yield* sql<{
						name: string;
					}>`PRAGMA table_info(projection_failures)`;
					expect(projectionFailureColumns.map((row) => row.name)).toContain(
						"event_sequence",
					);
					expect(yield* makeEffectSqlMigrator()).toEqual([]);
				}).pipe(
					Effect.provide(
						makeFileSqlLayer((filename) => {
							const db = new Database(filename);
							try {
								seedLegacyEventStore(db, legacyId);
							} finally {
								db.close();
							}
						}),
					),
				),
		);
	}

	it.effect(
		"adds the sessions permission mode column to a migration-8 database",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				const sql = yield* SqlClient.SqlClient;
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(
					columns.filter((column) => column.name === "permission_mode"),
				).toHaveLength(1);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) => {
						const db = new Database(filename);
						try {
							seedLegacyEventStore(db, 8);
						} finally {
							db.close();
						}
					}),
				),
			),
	);

	it.effect(
		"is idempotent when the sessions permission mode column already exists",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator();
				const sql = yield* SqlClient.SqlClient;
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(
					columns.filter((column) => column.name === "permission_mode"),
				).toHaveLength(1);
				const history = yield* sql<{ name: string }>`
				SELECT name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(history.map((row) => row.name)).toEqual(expectedNames);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) => {
						const db = new Database(filename);
						try {
							seedLegacyEventStore(db, 8);
							db.exec("ALTER TABLE sessions ADD COLUMN permission_mode TEXT");
						} finally {
							db.close();
						}
					}),
				),
			),
	);

	it.effect(
		"backfills existing fork ordering once and retains unresolved legacy lineage",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(prefix(21));
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at)
				VALUES ('parent', 'claude', 'Parent', 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, text, created_at, updated_at)
				VALUES ('boundary', 'parent', 'assistant', 'answer', 1000, 1000)`;
				yield* sql`INSERT INTO sessions
				(id, provider, title, parent_id, fork_point_event, created_at, updated_at)
				VALUES ('child', 'claude', 'Child', 'parent', 'boundary', 2000, 2000),
				('legacy', 'claude', 'Legacy', 'parent', 'missing', 2000, 2000)`;
				yield* makeEffectSqlMigrator();
				yield* sql`DELETE FROM messages WHERE id = 'boundary'`;
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
				const rows = yield* sql<{
					id: string;
					fork_point_timestamp: number | null;
					fork_point_message_id: string | null;
				}>`SELECT id, fork_point_timestamp, fork_point_message_id FROM sessions
				WHERE parent_id IS NOT NULL ORDER BY id`;
				expect(rows).toEqual([
					{
						id: "child",
						fork_point_timestamp: 1000,
						fork_point_message_id: "boundary",
					},
					{
						id: "legacy",
						fork_point_timestamp: null,
						fork_point_message_id: null,
					},
				]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	it.effect(
		"creates a fresh database with main behavior and feature stamps",
		() =>
			Effect.gen(function* () {
				const applied = yield* makeEffectSqlMigrator();
				expect(applied).toHaveLength(expectedNames.length);
				const sql = yield* SqlClient.SqlClient;
				const history = yield* sql<{ migration_id: number; name: string }>`
				SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
				expect(history.map((row) => row.name)).toEqual(expectedNames);
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(sessions)`;
				expect(columns.map((row) => row.name)).toEqual(
					expect.arrayContaining([
						"read_at",
						"last_turn_error_at",
						"settled_at",
						"pinned_at",
						"snoozed_at",
						"auto_settle_disabled_at",
						"version",
						"fork_point_timestamp",
						"fork_point_message_id",
					]),
				);
				expect(columns.map((row) => row.name)).not.toContain("last_viewed_at");
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(makeFileSqlLayer())),
	);

	for (const mainId of [17, 13, 2]) {
		it.effect(
			`upgrades a main Effect ${mainId} database and repeats as a no-op`,
			() =>
				Effect.gen(function* () {
					yield* makeEffectSqlMigrator(prefix(mainId));
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at)
					VALUES ('kept', 'opencode', 'Preserved', 1900000000000, 1900000000000)`;
					const applied = yield* makeEffectSqlMigrator();
					expect(applied).toHaveLength(expectedNames.length - mainId);
					const history = yield* sql<{ migration_id: number; name: string }>`
					SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
					expect(history.map((row) => row.name)).toEqual(expectedNames);
					const rows = yield* sql<{ title: string; version: number }>`
					SELECT title, version FROM sessions WHERE id = 'kept'`;
					expect(rows).toEqual([
						{ title: "Preserved", version: expect.any(Number) },
					]);
					expect(yield* makeEffectSqlMigrator()).toEqual([]);
				}).pipe(Effect.provide(makeFileSqlLayer())),
		);
	}

	it.effect("refuses a feature name occupying a main-owned migration id", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(prefix(17));
			const sql = yield* SqlClient.SqlClient;
			yield* sql`UPDATE effect_sql_migrations SET name = 'create_projection_failures'
				WHERE migration_id = 12`;
			const result = yield* Effect.either(makeEffectSqlMigrator());
			expect(Either.isLeft(result)).toBe(true);
			if (Either.isLeft(result)) {
				expect(result.left.message).toContain("Stale feature migration");
			}
			const history = yield* sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM effect_sql_migrations`;
			expect(history[0]?.count).toBe(17);
		}).pipe(Effect.provide(makeFileSqlLayer())),
	);
});
