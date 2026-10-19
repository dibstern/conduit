// test/unit/persistence/persistence-effect.test.ts

import fs, { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Logger } from "effect";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import {
	makePersistenceServiceLive,
	PersistenceProjectTag,
	PersistenceServiceTag,
	withTransaction,
} from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	LEGACY_SKELETON_CUTOFF_MS,
	MAX_PURGEABLE_SKELETON_SESSIONS,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { seedLegacyEventStore } from "../../helpers/legacy-event-store.js";

const testPersistenceServiceLive = makePersistenceServiceLive.pipe(
	Layer.provide(
		Layer.succeed(PersistenceProjectTag)({ projectId: "test-project" }),
	),
);

function makeTestSqlLayer(setup?: (filename: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "conduit-persistence-effect-"));
	const filename = join(dir, "events.db");
	setup?.(filename);
	return EffectSqliteClient.layer({ filename }).pipe(
		Layer.merge(
			Layer.effectDiscard(
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
			Layer.effectDiscard(
				Effect.addFinalizer(() =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			),
		),
	);
}

function makePersistenceLayer(setup?: (filename: string) => void) {
	return Layer.provideMerge(
		testPersistenceServiceLive,
		makeTestSqlLayer(setup),
	);
}

function seedDatabase(filename: string, seed: (db: DatabaseSync) => void) {
	const db = new DatabaseSync(filename);
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

function seedTrippedDatabase(db: DatabaseSync) {
	seedLegacyEventStore(db);
	for (let index = 0; index <= MAX_PURGEABLE_SKELETON_SESSIONS; index++) {
		db.prepare(
			"INSERT INTO sessions (id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)",
		).run(
			`matching-${index.toString().padStart(2, "0")}`,
			"opencode",
			LEGACY_SKELETON_CUTOFF_MS - 1,
			LEGACY_SKELETON_CUTOFF_MS - 1,
		);
	}
}

function makeErrorLogger(messages: string[]) {
	const logger = Logger.make<unknown, void>((options) => {
		if (options.logLevel !== "Error") return;
		const parts = Array.isArray(options.message)
			? options.message
			: [options.message];
		messages.push(parts.map(String).join(" "));
	});
	return Logger.layer([logger, Logger.tracerLogger]);
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
			const projectionFailureColumns = yield* sql<{
				cid: number;
				name: string;
				type: string;
				notnull: number;
				dflt_value: string | null;
				pk: number;
			}>`PRAGMA table_info(projection_failures)`;
			const projectionFailures = yield* sql<Record<string, unknown>>`
				SELECT * FROM projection_failures`;
			expect({
				tables: tables.map((row) => row.name),
				projectionFailureColumns,
				projectionFailures,
			}).toEqual({
				tables: [
					"command_receipts",
					"daemon_store_imports",
					"events",
					"input_drafts",
					"message_part_tombstones",
					"message_parts",
					"message_tombstones",
					"messages",
					"pending_approvals",
					"pending_inputs",
					"projection_failures",
					"projector_cursors",
					"provider_command_interactions",
					"provider_command_meta",
					"provider_command_outbox",
					"provider_command_sessions",
					"provider_command_tombstones",
					"provider_command_turns",
					"provider_state",
					"read_model_counter",
					"sent_alerts",
					"session_git_published",
					"session_goal_checks",
					"session_pick_backfill",
					"session_pick_backfill_state",
					"session_providers",
					"session_sidebar",
					"session_sidebar_horizon",
					"sessions",
					"store_identity",
					"tool_content",
					"turns",
				],
				projectionFailureColumns: [
					{
						cid: 0,
						name: "id",
						type: "INTEGER",
						notnull: 0,
						dflt_value: null,
						pk: 1,
					},
					{
						cid: 1,
						name: "projector_name",
						type: "TEXT",
						notnull: 1,
						dflt_value: null,
						pk: 0,
					},
					{
						cid: 2,
						name: "event_sequence",
						type: "INTEGER",
						notnull: 1,
						dflt_value: null,
						pk: 0,
					},
					{
						cid: 3,
						name: "event_type",
						type: "TEXT",
						notnull: 1,
						dflt_value: null,
						pk: 0,
					},
					{
						cid: 4,
						name: "session_id",
						type: "TEXT",
						notnull: 1,
						dflt_value: null,
						pk: 0,
					},
					{
						cid: 5,
						name: "error",
						type: "TEXT",
						notnull: 1,
						dflt_value: null,
						pk: 0,
					},
					{
						cid: 6,
						name: "failed_at",
						type: "INTEGER",
						notnull: 1,
						dflt_value: null,
						pk: 0,
					},
				],
				projectionFailures: [],
			});

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
				"project_id",
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
				{ migration_id: 11, name: "session_cascade_deletes" },
				{ migration_id: 12, name: "sessions_read_at" },
				{ migration_id: 13, name: "sessions_last_turn_error" },
				{ migration_id: 14, name: "backfill_compaction_messages" },
				{ migration_id: 15, name: "sessions_settled_pinned" },
				{ migration_id: 16, name: "sessions_snoozed" },
				{ migration_id: 17, name: "sessions_auto_settle" },
				{ migration_id: 18, name: "create_projection_failures" },
				{ migration_id: 19, name: "read_model_version" },
				{ migration_id: 20, name: "read_model_counter" },
				{ migration_id: 21, name: "sent_alerts" },
				{ migration_id: 22, name: "fork_point_timestamp" },
				{ migration_id: 23, name: "sessions_marked_unread" },
				{ migration_id: 24, name: "session_attention" },
				{ migration_id: 25, name: "read_state_to_turn_ends" },
				{ migration_id: 26, name: "sessions_forked_from" },
				{ migration_id: 27, name: "messages_backfilled" },
				{ migration_id: 28, name: "sessions_history_complete" },
				{ migration_id: 29, name: "message_tombstones" },
				{ migration_id: 30, name: "session_goals" },
				{ migration_id: 31, name: "startup_restore_indexes" },
				{ migration_id: 32, name: "tool_call_index" },
				{ migration_id: 33, name: "pending_approvals_version" },
				{ migration_id: 34, name: "sessions_model_settings" },
				{ migration_id: 35, name: "sessions_side_thread" },
				{ migration_id: 36, name: "sessions_limit_recovery" },
				{ migration_id: 37, name: "sessions_resumes" },
				{ migration_id: 38, name: "session_sidebar" },
				{ migration_id: 39, name: "session_sidebar_tombstones" },
				{ migration_id: 40, name: "sessions_workspace" },
				{ migration_id: 41, name: "messages_input_id" },
				{ migration_id: 42, name: "pending_inputs" },
				{ migration_id: 43, name: "messages_steered" },
				{ migration_id: 44, name: "sessions_last_turn_end_input_id" },
				{ migration_id: 45, name: "project_provenance" },
				{ migration_id: 46, name: "messages_context_tokens" },
				{ migration_id: 47, name: "messages_completed_at" },
				{ migration_id: 48, name: "sessions_claude_worktree_state" },
				{ migration_id: 49, name: "sessions_workspace_hint" },
				{ migration_id: 50, name: "sessions_pending_rewind" },
				{ migration_id: 51, name: "message_part_versions" },
				{ migration_id: 52, name: "session_git_published" },
				{ migration_id: 53, name: "store_identity" },
				{ migration_id: 54, name: "events_unstamped_index" },
				{ migration_id: 55, name: "events_session_type_index" },
				{ migration_id: 56, name: "drop_activities" },
				{ migration_id: 57, name: "session_pick_backfill" },
				{ migration_id: 58, name: "compact_redundant_events" },
				{ migration_id: 59, name: "session_project_scope" },
				{ migration_id: 60, name: "daemon_store_imports" },
				{ migration_id: 61, name: "sessions_lineage" },
				{ migration_id: 62, name: "legacy_forks" },
				{ migration_id: 63, name: "sessions_archived" },
				{ migration_id: 64, name: "prompt_provider_reference" },
				{ migration_id: 65, name: "tool_result_event_refs" },
				{ migration_id: 66, name: "project_tree_data" },
				{ migration_id: 67, name: "purge_background_shell_sessions" },
				{ migration_id: 68, name: "input_drafts" },
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
		}).pipe(Effect.provide(makePersistenceLayer(), { local: true })),
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
					testPersistenceServiceLive,
					EffectSqliteClient.layer({ filename: ":memory:" }),
				),
				{ local: true },
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
				{ local: true },
			),
		),
	);

	it.effect(
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
					testPersistenceServiceLive,
					EffectSqliteClient.layer({ filename }),
				);

				yield* Effect.provide(PersistenceServiceTag, layer, { local: true });
				yield* Effect.provide(PersistenceServiceTag, layer, { local: true });

				expect(
					messages.filter((message) =>
						message.includes(
							"Legacy skeleton purge circuit breaker is TRIPPED",
						),
					),
				).toHaveLength(2);
			}).pipe(Effect.provide(makeErrorLogger(messages), { local: true }));
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
				Effect.provide(makePersistenceLayer(), { local: true }),
				Effect.provide(makeErrorLogger(messages), { local: true }),
			);
		},
	);

	it.effect(
		"rejects an unknown migration ledger before changing the database",
		() =>
			Effect.gen(function* () {
				const result = yield* Effect.result(
					Effect.gen(function* () {
						yield* PersistenceServiceTag;
					}).pipe(
						Effect.provide(
							makePersistenceLayer((filename) =>
								seedDatabase(filename, (db) => {
									seedLegacyEventStore(db);
									db.exec(`
							CREATE TABLE effect_sql_migrations (
								migration_id INTEGER PRIMARY KEY NOT NULL,
								created_at DATETIME NOT NULL DEFAULT current_timestamp,
								name VARCHAR(255) NOT NULL
							);
							INSERT INTO effect_sql_migrations (migration_id, name)
							VALUES (13, 'foreign_migration');
							DROP TABLE message_parts;
							DROP TABLE messages;
						`);
								}),
							),
							{ local: true },
						),
					),
				);
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure")
					expectMigrationFailure(result.failure, "Unknown recorded migration");
			}),
	);

	it.effect("diagnostic defect cannot prevent startup", () =>
		Effect.gen(function* () {
			yield* PersistenceServiceTag;
		}).pipe(
			Effect.provide(
				makePersistenceLayer((filename) =>
					seedDatabase(filename, seedTrippedDatabase),
				),
				{ local: true },
			),
			Effect.provide(
				Logger.layer([
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
					Logger.tracerLogger,
				]),
				{ local: true },
			),
		),
	);

	it("diagnostic failure cannot prevent startup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-diagnostic-failure-"));
		const filename = join(dir, "events.db");
		try {
			await Effect.runPromise(
				makeEffectSqlMigrator().pipe(
					Effect.provide(EffectSqliteClient.layer({ filename }), {
						local: true,
					}),
				),
			);
			seedDatabase(filename, (db) => db.exec("DROP TABLE messages"));
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* PersistenceServiceTag;
				}).pipe(
					Effect.provide(
						Layer.provideMerge(
							testPersistenceServiceLive,
							EffectSqliteClient.layer({ filename }),
						),
						{ local: true },
					),
				),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.effect("startup migration refuses readonly Effect SQLite layers", () =>
		Effect.gen(function* () {
			const result = yield* Effect.result(
				Effect.gen(function* () {
					yield* PersistenceServiceTag;
				}).pipe(
					Effect.provide(
						Layer.provideMerge(
							testPersistenceServiceLive,
							makeReadonlySqlLayer(),
						),
						{ local: true },
					),
				),
			);

			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expectMigrationFailure(result.failure, "Failed to execute statement");
			}
		}),
	);

	it.effect.each(["reclaim", "below threshold", "low disk", "rename failure"])(
		"file-backed startup stays healthy after %s",
		(scenario) => {
			const messages: string[] = [];
			const logger = Logger.make<unknown, void>((options) => {
				const parts = Array.isArray(options.message)
					? options.message
					: [options.message];
				messages.push(parts.map(String).join(" "));
			});
			return Effect.gen(function* () {
				const dir = yield* Effect.sync(() =>
					mkdtempSync(join(tmpdir(), "conduit-startup-reclaim-")),
				);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						vi.restoreAllMocks();
						syncBuiltinESMExports();
						rmSync(dir, { recursive: true, force: true });
					}),
				);
				const filename = join(dir, "events.db");
				yield* PersistenceServiceTag.pipe(
					Effect.provide(makePersistenceEffectLayer(filename, "test-project"), {
						local: true,
					}),
					Effect.asVoid,
				);
				let retainedRows: Record<string, unknown>[] = [];
				seedDatabase(filename, (db) => {
					db.exec("DELETE FROM effect_sql_migrations WHERE migration_id = 58");
					const insert = db.prepare(
						`INSERT INTO events
						(event_id, session_id, stream_version, type, data, created_at, project_id, provider)
						VALUES (?, 'startup-session', ?, ?, ?, ?, 'test-project', 'claude')`,
					);
					insert.run("start", 1, "thinking.start", '{"partId":"part"}', 1);
					insert.run("end", 2, "thinking.end", '{"partId":"part"}', 2);
					retainedRows = db
						.prepare("SELECT * FROM events ORDER BY sequence")
						.all();
					if (scenario === "below threshold") return;
					db.exec("BEGIN");
					try {
						for (let index = 0; index < 80; index++) {
							insert.run(
								`redundant-${index}`,
								index + 3,
								"thinking.end",
								JSON.stringify({ partId: "part", padding: "x".repeat(8192) }),
								index + 3,
							);
						}
						db.exec("COMMIT");
					} catch (cause) {
						db.exec("ROLLBACK");
						throw cause;
					}
					retainedRows = db
						.prepare(
							`SELECT * FROM events
							WHERE event_id IN ('start', 'end', 'redundant-79')
							ORDER BY sequence`,
						)
						.all();
				});
				const beforeBytes = statSync(filename).size;
				const disk = vi.spyOn(fs, "statfsSync");
				if (scenario === "low disk") {
					disk.mockImplementation(() => ({
						type: 0,
						bsize: 4096,
						frsize: 4096,
						blocks: 0,
						bfree: 0,
						bavail: 0,
						files: 0,
						ffree: 0,
					}));
				}
				if (scenario === "rename failure") {
					vi.spyOn(fs, "renameSync").mockImplementation(() => {
						throw new Error("promotion failed");
					});
				}
				syncBuiltinESMExports();
				yield* Effect.gen(function* () {
					const persistence = yield* PersistenceServiceTag;
					const sql = yield* SqlClient.SqlClient;
					expect(yield* persistence.healthCheck).toBe(true);
					expect(
						yield* sql<Record<string, unknown>>`
							SELECT * FROM events ORDER BY sequence`,
					).toEqual(retainedRows);
					expect(yield* sql`PRAGMA quick_check`).toEqual([
						{ quick_check: "ok" },
					]);
				}).pipe(
					Effect.provide(makePersistenceEffectLayer(filename, "test-project"), {
						local: true,
					}),
				);
				const afterBytes = statSync(filename).size;
				if (scenario === "reclaim") {
					expect(afterBytes).toBeLessThan(beforeBytes / 2);
					expect(messages.join(" ")).toContain("Reclaimed event store space");
				} else {
					expect(afterBytes).toBe(beforeBytes);
					expect(messages.join(" ")).not.toContain(
						"Reclaimed event store space",
					);
				}
				if (scenario === "below threshold") expect(disk).not.toHaveBeenCalled();
				if (scenario === "low disk") {
					expect(messages.join(" ")).toContain("insufficient disk");
				}
				if (scenario === "rename failure") {
					expect(messages.join(" ")).toContain("keeping original");
				}
				expect(
					readdirSync(dir).filter((name) => name.includes(".tmp")),
				).toEqual([]);
			}).pipe(
				Effect.provide(Logger.layer([logger, Logger.tracerLogger]), {
					local: true,
				}),
			);
		},
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
		}).pipe(Effect.provide(makeTestSqlLayer(), { local: true })),
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
			).pipe(Effect.catch(() => Effect.void));
			const rows = yield* sql`SELECT * FROM test_rollback`;
			expect(rows.length).toBe(0);
		}).pipe(Effect.provide(makeTestSqlLayer(), { local: true })),
	);
});
