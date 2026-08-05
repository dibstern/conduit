// test/unit/persistence/persistence-effect.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Logger } from "effect";
import { expect } from "vitest";
import {
	makePersistenceServiceLive,
	PersistenceServiceTag,
	withTransaction,
} from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import {
	LEGACY_SKELETON_CUTOFF_MS,
	MAX_PURGEABLE_SKELETON_SESSIONS,
} from "../../../src/lib/persistence/effect/migrations.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient as SyncSqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

function makeTestSqlLayer(setup?: (filename: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "conduit-persistence-effect-"));
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

function makeReadonlySqlLayer() {
	const dir = mkdtempSync(join(tmpdir(), "conduit-persistence-effect-ro-"));
	const filename = join(dir, "events.db");
	seedDatabase(filename, () => {});
	return EffectSqliteClient.layer({
		filename,
		readonly: true,
		disableWAL: true,
	}).pipe(
		Layer.merge(
			Layer.scopedDiscard(
				Effect.addFinalizer(() =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			),
		),
	);
}

function makePersistenceLayer(setup?: (filename: string) => void) {
	return Layer.provideMerge(
		makePersistenceServiceLive,
		makeTestSqlLayer(setup),
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

function expectMigrationFailure(error: unknown, reason: string) {
	const persistenceError = error as {
		readonly operation: string;
		cause: unknown;
	};
	expect(persistenceError.operation).toBe("migrate");
	expect(String(persistenceError.cause)).toContain(reason);
}

function seedTrippedDatabase(db: SyncSqliteClient) {
	runMigrations(db, schemaMigrations);
	for (let index = 0; index <= MAX_PURGEABLE_SKELETON_SESSIONS; index++) {
		db.execute(
			"INSERT INTO sessions (id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)",
			[
				`matching-${index.toString().padStart(2, "0")}`,
				"opencode",
				LEGACY_SKELETON_CUTOFF_MS - 1,
				LEGACY_SKELETON_CUTOFF_MS - 1,
			],
		);
	}
}

function makeErrorLogger(messages: string[]) {
	const logger = Logger.make<unknown, void>((options) => {
		if (options.logLevel._tag !== "Error") return;
		const parts = Array.isArray(options.message)
			? options.message
			: [options.message];
		messages.push(parts.map(String).join(" "));
	});
	return Logger.replace(Logger.defaultLogger, logger);
}

describe("Persistence Effect", () => {
	it.effect("startup migration creates the production event-store schema", () =>
		Effect.gen(function* () {
			const persistence = yield* PersistenceServiceTag;
			const sql = yield* SqlClient.SqlClient;

			const tables = yield* sql<{ name: string }>`
				SELECT name FROM sqlite_master
				WHERE type='table'
					AND name NOT LIKE '\\_%' ESCAPE '\\'
					AND name NOT LIKE 'sqlite_%'
					AND name != 'effect_sql_migrations'
				ORDER BY name`;
			expect(tables.map((row) => row.name)).toEqual([
				"activities",
				"command_receipts",
				"events",
				"message_parts",
				"messages",
				"pending_approvals",
				"projector_cursors",
				"provider_command_interactions",
				"provider_command_meta",
				"provider_command_outbox",
				"provider_command_sessions",
				"provider_command_tombstones",
				"provider_command_turns",
				"provider_state",
				"session_providers",
				"sessions",
				"tool_content",
				"turns",
			]);

			const eventColumns = yield* sql<{
				name: string;
			}>`PRAGMA table_info(events)`;
			expect(eventColumns.map((column) => column.name)).toEqual([
				"sequence",
				"event_id",
				"session_id",
				"stream_version",
				"type",
				"data",
				"metadata",
				"provider",
				"created_at",
			]);
			const turnColumns = yield* sql<{ name: string }>`
				PRAGMA table_info(turns)`;
			expect(turnColumns.map((column) => column.name)).toEqual(
				expect.arrayContaining([
					"requested_model",
					"expected_model",
					"actual_model",
				]),
			);

			const migrationRows = yield* sql<{
				migration_id: number;
				name: string;
			}>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
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

			const legacyMigrationTable = yield* sql<{ name: string }>`
				SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'`;
			expect(legacyMigrationTable).toEqual([]);

			yield* persistence.migrate;

			const afterSecondRun = yield* sql<{
				migration_id: number;
				name: string;
			}>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
			expect(afterSecondRun).toEqual(migrationRows);
		}).pipe(Effect.provide(makePersistenceLayer())),
	);

	it.effect("startup migration supports in-memory Effect SQLite layers", () =>
		Effect.gen(function* () {
			yield* PersistenceServiceTag;
			const sql = yield* SqlClient.SqlClient;
			const tables = yield* sql<{ name: string }>`
				SELECT name FROM sqlite_master
				WHERE type='table' AND name IN ('events', 'effect_sql_migrations')
				ORDER BY name`;
			expect(tables.map((row) => row.name)).toEqual([
				"effect_sql_migrations",
				"events",
			]);
		}).pipe(
			Effect.provide(
				Layer.provideMerge(
					makePersistenceServiceLive,
					EffectSqliteClient.layer({ filename: ":memory:" }),
				),
			),
		),
	);

	it.effect("startup completes when the legacy skeleton breaker trips", () =>
		Effect.gen(function* () {
			yield* PersistenceServiceTag;
		}).pipe(
			Effect.provide(
				makePersistenceLayer((filename) =>
					seedDatabase(filename, seedTrippedDatabase),
				),
			),
		),
	);

	it.scoped(
		"re-announces a tripped legacy skeleton breaker on every startup",
		() => {
			const messages: string[] = [];
			return Effect.gen(function* () {
				const dir = yield* Effect.sync(() =>
					mkdtempSync(join(tmpdir(), "conduit-persistence-breaker-")),
				);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				);
				const filename = join(dir, "events.db");
				seedDatabase(filename, seedTrippedDatabase);
				const layer = Layer.provideMerge(
					makePersistenceServiceLive,
					EffectSqliteClient.layer({ filename }),
				);

				yield* Effect.provide(PersistenceServiceTag, layer);
				yield* Effect.provide(PersistenceServiceTag, layer);

				expect(
					messages.filter((message) =>
						message.includes(
							"Legacy skeleton purge circuit breaker is TRIPPED",
						),
					),
				).toHaveLength(2);
			}).pipe(Effect.provide(makeErrorLogger(messages)));
		},
	);

	it.effect(
		"does not announce the legacy skeleton breaker for a clean store",
		() => {
			const messages: string[] = [];
			return Effect.gen(function* () {
				yield* PersistenceServiceTag;
				expect(
					messages.some((message) =>
						message.includes(
							"Legacy skeleton purge circuit breaker is TRIPPED",
						),
					),
				).toBe(false);
			}).pipe(
				Effect.provide(makePersistenceLayer()),
				Effect.provide(makeErrorLogger(messages)),
			);
		},
	);

	it.effect("diagnostic failure cannot prevent startup", () =>
		Effect.gen(function* () {
			yield* PersistenceServiceTag;
		}).pipe(
			Effect.provide(
				makePersistenceLayer((filename) =>
					seedDatabase(filename, (db) => {
						runMigrations(db, schemaMigrations);
						db.exec(`
							CREATE TABLE effect_sql_migrations (
								migration_id INTEGER PRIMARY KEY NOT NULL,
								created_at DATETIME NOT NULL DEFAULT current_timestamp,
								name VARCHAR(255) NOT NULL
							);
							INSERT INTO effect_sql_migrations (migration_id, name)
							VALUES (10, 'purge_legacy_skeleton_sessions');
							DROP TABLE message_parts;
							DROP TABLE messages;
						`);
					}),
				),
			),
		),
	);

	it.effect("diagnostic defect cannot prevent startup", () =>
		Effect.gen(function* () {
			yield* PersistenceServiceTag;
		}).pipe(
			Effect.provide(
				makePersistenceLayer((filename) =>
					seedDatabase(filename, seedTrippedDatabase),
				),
			),
			Effect.provide(
				Logger.replace(
					Logger.defaultLogger,
					Logger.make<unknown, void>((options) => {
						const parts = Array.isArray(options.message)
							? options.message
							: [options.message];
						if (
							parts
								.map(String)
								.join(" ")
								.includes("Legacy skeleton purge circuit breaker is TRIPPED")
						) {
							throw new Error("diagnostic defect");
						}
					}),
				),
			),
		),
	);

	it.effect("startup migration refuses readonly Effect SQLite layers", () =>
		Effect.gen(function* () {
			const result = yield* Effect.either(
				Effect.gen(function* () {
					yield* PersistenceServiceTag;
				}).pipe(
					Effect.provide(
						Layer.provideMerge(
							makePersistenceServiceLive,
							makeReadonlySqlLayer(),
						),
					),
				),
			);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expectMigrationFailure(result.left, "Failed to execute statement");
			}
		}),
	);

	it.effect("healthCheck returns true", () =>
		Effect.gen(function* () {
			const persistence = yield* PersistenceServiceTag;
			const healthy = yield* persistence.healthCheck;
			expect(healthy).toBe(true);
		}).pipe(Effect.provide(makePersistenceLayer())),
	);

	it.effect("evictBefore deletes old events", () =>
		Effect.gen(function* () {
			const persistence = yield* PersistenceServiceTag;
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES ('s-evict', 'opencode', 'Evict', 'idle', 1000, 1000)`;
			yield* sql`INSERT INTO events (
					event_id, session_id, stream_version, type, data, metadata, provider, created_at
				) VALUES (
					'evt-old', 's-evict', 0, 'session.created', '{}', '{}', 'opencode', 1000
				)`;
			yield* sql`INSERT INTO events (
					event_id, session_id, stream_version, type, data, metadata, provider, created_at
				) VALUES (
					'evt-new', 's-evict', 1, 'session.status', '{}', '{}', 'opencode', 9999999999
				)`;
			const deleted = yield* persistence.evictBefore(5000);
			expect(deleted).toBe(1);
			const remaining = yield* sql`SELECT * FROM events`;
			expect(remaining.length).toBe(1);
		}).pipe(Effect.provide(makePersistenceLayer())),
	);

	it.effect("withTransaction commits on success", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE test_items (id INTEGER PRIMARY KEY, name TEXT)`;
			yield* withTransaction(
				sql`INSERT INTO test_items (id, name) VALUES (1, 'item-1')`,
			);
			const rows = yield* sql`SELECT * FROM test_items`;
			expect(rows.length).toBe(1);
		}).pipe(Effect.provide(makeTestSqlLayer())),
	);

	it.effect("withTransaction rolls back on failure", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE test_rollback (id INTEGER PRIMARY KEY, name TEXT)`;
			yield* withTransaction(
				Effect.gen(function* () {
					yield* sql`INSERT INTO test_rollback (id, name) VALUES (1, 'x')`;
					yield* Effect.fail(new Error("boom"));
				}),
			).pipe(Effect.catchAll(() => Effect.void));
			const rows = yield* sql`SELECT * FROM test_rollback`;
			expect(rows.length).toBe(0);
		}).pipe(Effect.provide(makeTestSqlLayer())),
	);
});
