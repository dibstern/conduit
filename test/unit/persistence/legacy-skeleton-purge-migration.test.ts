import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import Database from "better-sqlite3";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
	effectMigrationEntries,
	LEGACY_SKELETON_CUTOFF_MS,
	MAX_PURGEABLE_SKELETON_SESSIONS,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { seedLegacyEventStore } from "../../helpers/legacy-event-store.js";

// Keep the purge regression fixtures on the schema that shipped with migration 10.
const migrationsThroughPurge = Object.fromEntries(
	Object.entries(effectMigrationEntries).filter(
		([key]) => Number(key.slice(0, 4)) <= 10,
	),
);

function makeFileSqlLayer(setup: (filename: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "conduit-legacy-skeleton-purge-"));
	const filename = join(dir, "events.db");
	setup(filename);
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

function seedSession(
	db: Database.Database,
	id: string,
	createdAt = LEGACY_SKELETON_CUTOFF_MS - 1,
	provider = "opencode",
) {
	db.prepare(
		"INSERT INTO sessions (id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)",
	).run([id, provider, createdAt, createdAt]);
}

function seedMatchingSessions(
	db: Database.Database,
	count: number,
	prefix = "matching",
) {
	for (let index = 0; index < count; index++) {
		seedSession(db, `${prefix}-${index.toString().padStart(2, "0")}`);
	}
}

function seedDatabase(filename: string, seed: (db: Database.Database) => void) {
	const db = new Database(filename);
	try {
		seedLegacyEventStore(db, 9);
		seed(db);
	} finally {
		db.close();
	}
}

describe("legacy skeleton purge migration", () => {
	it.effect("preserves a pre-cutoff OpenCode session that has messages", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(migrationsThroughPurge);
			const sql = yield* SqlClient.SqlClient;

			const sessions =
				yield* sql`SELECT id FROM sessions WHERE id = 'with-message'`;
			const messages =
				yield* sql`SELECT id FROM messages WHERE id = 'message-1'`;
			const parts =
				yield* sql`SELECT id FROM message_parts WHERE id = 'part-1'`;
			const events =
				yield* sql`SELECT event_id FROM events WHERE event_id = 'event-1'`;

			expect(sessions).toHaveLength(1);
			expect(messages).toHaveLength(1);
			expect(parts).toHaveLength(1);
			expect(events).toHaveLength(1);
		}).pipe(
			Effect.provide(
				makeFileSqlLayer((filename) =>
					seedDatabase(filename, (db) => {
						db.prepare(
							"INSERT INTO sessions (id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)",
						).run([
							"with-message",
							"opencode",
							LEGACY_SKELETON_CUTOFF_MS - 1,
							LEGACY_SKELETON_CUTOFF_MS - 1,
						]);
						db.prepare(
							"INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
						).run([
							"message-1",
							"with-message",
							"user",
							LEGACY_SKELETON_CUTOFF_MS - 1,
							LEGACY_SKELETON_CUTOFF_MS - 1,
						]);
						db.prepare(
							"INSERT INTO message_parts (id, message_id, type, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
						).run([
							"part-1",
							"message-1",
							"text",
							0,
							LEGACY_SKELETON_CUTOFF_MS - 1,
							LEGACY_SKELETON_CUTOFF_MS - 1,
						]);
						db.prepare(
							"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
						).run([
							"event-1",
							"with-message",
							0,
							"session.created",
							"{}",
							"opencode",
							LEGACY_SKELETON_CUTOFF_MS - 1,
						]);
					}),
				),
			),
		),
	);

	it.effect("preserves an empty post-cutoff OpenCode session", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(migrationsThroughPurge);
			const sql = yield* SqlClient.SqlClient;
			const sessions =
				yield* sql`SELECT id FROM sessions WHERE id = 'post-cutoff'`;
			expect(sessions).toHaveLength(1);
		}).pipe(
			Effect.provide(
				makeFileSqlLayer((filename) =>
					seedDatabase(filename, (db) =>
						seedSession(db, "post-cutoff", LEGACY_SKELETON_CUTOFF_MS + 1),
					),
				),
			),
		),
	);

	it.effect("preserves an empty pre-cutoff non-OpenCode session", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(migrationsThroughPurge);
			const sql = yield* SqlClient.SqlClient;
			const sessions =
				yield* sql`SELECT id FROM sessions WHERE id = 'claude-session'`;
			expect(sessions).toHaveLength(1);
		}).pipe(
			Effect.provide(
				makeFileSqlLayer((filename) =>
					seedDatabase(filename, (db) =>
						seedSession(
							db,
							"claude-session",
							LEGACY_SKELETON_CUTOFF_MS - 1,
							"claude",
						),
					),
				),
			),
		),
	);

	it.effect(
		"purges the exact legacy skeleton cohort and all associated rows",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(migrationsThroughPurge);
				const sql = yield* SqlClient.SqlClient;
				const tables = [
					["sessions", "id"],
					["events", "session_id"],
					["turns", "session_id"],
					["activities", "session_id"],
					["pending_approvals", "session_id"],
					["session_providers", "session_id"],
					["tool_content", "session_id"],
					["provider_state", "session_id"],
					["command_receipts", "session_id"],
					["provider_command_sessions", "session_id"],
					["provider_command_turns", "session_id"],
					["provider_command_interactions", "session_id"],
					["provider_command_outbox", "session_id"],
					["provider_command_tombstones", "session_id"],
				] as const;
				for (const [table, column] of tables) {
					const rows = yield* sql.unsafe<{ count: number }>(
						`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
						["legacy-skeleton"],
					);
					expect(rows[0]?.count, table).toBe(0);
				}

				const cursors = yield* sql<{ projector_name: string }>`
					SELECT projector_name FROM projector_cursors`;
				expect(cursors).toEqual([{ projector_name: "sessions" }]);
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) => {
							seedSession(db, "legacy-skeleton");
							for (const [eventId, streamVersion, type] of [
								["event-created", 0, "session.created"],
								["event-renamed", 1, "session.renamed"],
							] as const) {
								db.prepare(
									"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
								).run([
									eventId,
									"legacy-skeleton",
									streamVersion,
									type,
									"{}",
									"opencode",
									LEGACY_SKELETON_CUTOFF_MS - 1,
								]);
							}
							db.prepare(
								"INSERT INTO turns (id, session_id, requested_at) VALUES (?, ?, ?)",
							).run([
								"turn-1",
								"legacy-skeleton",
								LEGACY_SKELETON_CUTOFF_MS - 1,
							]);
							db.prepare(
								"INSERT INTO activities (id, session_id, tone, kind, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
							).run([
								"activity-1",
								"legacy-skeleton",
								"info",
								"status",
								"x",
								1,
							]);
							db.prepare(
								"INSERT INTO pending_approvals (id, session_id, type, created_at) VALUES (?, ?, ?, ?)",
							).run(["approval-1", "legacy-skeleton", "permission", 1]);
							db.prepare(
								"INSERT INTO session_providers (id, session_id, provider, activated_at) VALUES (?, ?, ?, ?)",
							).run(["session-provider-1", "legacy-skeleton", "opencode", 1]);
							db.prepare(
								"INSERT INTO tool_content (tool_id, session_id, content, created_at) VALUES (?, ?, ?, ?)",
							).run(["tool-1", "legacy-skeleton", "x", 1]);
							db.prepare(
								"INSERT INTO provider_state (session_id, key, value) VALUES (?, ?, ?)",
							).run(["legacy-skeleton", "key", "value"]);
							db.prepare(
								"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
							).run(["command-1", "legacy-skeleton", "accepted", 1]);
							db.prepare(
								"INSERT INTO provider_command_sessions (project_key, session_id, provider_id, provider_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
							).run([
								"project",
								"legacy-skeleton",
								"provider",
								"opencode",
								"active",
								1,
								1,
							]);
							db.prepare(
								"INSERT INTO provider_command_turns (project_key, session_id, turn_id, command_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
							).run([
								"project",
								"legacy-skeleton",
								"turn-1",
								"command-1",
								"active",
								1,
								1,
							]);
							db.prepare(
								"INSERT INTO provider_command_interactions (project_key, session_id, interaction_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
							).run([
								"project",
								"legacy-skeleton",
								"interaction-1",
								"permission",
								"pending",
								1,
								1,
							]);
							db.prepare(
								"INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, requested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
							).run([
								1,
								"command-1",
								"project",
								"legacy-skeleton",
								"provider",
								"send",
								"{}",
								1,
								1,
							]);
							db.prepare(
								"INSERT INTO provider_command_tombstones (project_key, scope_kind, scope_id, session_id, event_sequence, reason_code, tombstoned_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
							).run([
								"project",
								"session",
								"legacy-skeleton",
								"legacy-skeleton",
								1,
								"deleted",
								1,
							]);
							db.prepare(
								"INSERT INTO projector_cursors (projector_name, last_applied_seq, updated_at) VALUES (?, ?, ?)",
							).run(["sessions", 2, 1]);
						}),
					),
				),
			),
	);

	it.effect("purges a forked parent and child in child-first order", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(migrationsThroughPurge);
			const sql = yield* SqlClient.SqlClient;
			const remaining = yield* sql<{
				id: string;
			}>`SELECT id FROM sessions WHERE id IN ('a-parent', 'z-child')`;
			expect(remaining).toEqual([]);
		}).pipe(
			Effect.provide(
				makeFileSqlLayer((filename) =>
					seedDatabase(filename, (db) => {
						seedSession(db, "a-parent");
						db.prepare(
							"INSERT INTO sessions (id, provider, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
						).run([
							"z-child",
							"opencode",
							"a-parent",
							LEGACY_SKELETON_CUTOFF_MS - 1,
							LEGACY_SKELETON_CUTOFF_MS - 1,
						]);
					}),
				),
			),
		),
	);

	it("terminates when a legacy skeleton session is its own parent", () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-cycle-guard-"));
		const filename = join(dir, "events.db");
		try {
			seedDatabase(filename, (db) => {
				seedSession(db, "self-parent");
				db.prepare("UPDATE sessions SET parent_id = id WHERE id = ?").run([
					"self-parent",
				]);
			});
			execFileSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					`
							import { SqliteClient } from "@effect/sql-sqlite-node";
							import { Effect } from "effect";
							import { makeEffectSqlMigrator, effectMigrationEntries } from "./src/lib/persistence/effect/migrations.ts";
							const migrationsThroughPurge = Object.fromEntries(
								Object.entries(effectMigrationEntries).filter(([key]) => Number(key.slice(0, 4)) <= 10),
							);

							await Effect.runPromise(
								makeEffectSqlMigrator(migrationsThroughPurge).pipe(
									Effect.provide(SqliteClient.layer({ filename: process.argv[1] })),
								),
							);
						`,
					filename,
				],
				{ timeout: 10_000 },
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);

	it.effect("is idempotent", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(migrationsThroughPurge);
			expect(yield* makeEffectSqlMigrator(migrationsThroughPurge)).toEqual([]);
			const sql = yield* SqlClient.SqlClient;
			const remaining = yield* sql<{
				id: string;
			}>`SELECT id FROM sessions ORDER BY id`;
			expect(remaining).toEqual([{ id: "recent-session" }]);
		}).pipe(
			Effect.provide(
				makeFileSqlLayer((filename) =>
					seedDatabase(filename, (db) => {
						seedSession(db, "legacy-skeleton");
						seedSession(db, "recent-session", LEGACY_SKELETON_CUTOFF_MS + 1);
					}),
				),
			),
		),
	);

	it.effect(
		"enforces the foreign-key backstop for sessions with children",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const result = yield* Effect.either(
					sql`DELETE FROM sessions WHERE id = 'with-message'`,
				);
				expect(result._tag).toBe("Left");
			}).pipe(
				Effect.provide(
					makeFileSqlLayer((filename) =>
						seedDatabase(filename, (db) => {
							seedSession(db, "with-message");
							db.prepare(
								"INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
							).run(["message-1", "with-message", "user", 1, 1]);
						}),
					),
				),
			),
	);

	it.effect("trips above the safety threshold without deleting sessions", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(migrationsThroughPurge);
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{
				count: number;
			}>`SELECT COUNT(*) AS count FROM sessions`;
			expect(rows[0]?.count).toBe(MAX_PURGEABLE_SKELETON_SESSIONS + 1);
		}).pipe(
			Effect.provide(
				makeFileSqlLayer((filename) =>
					seedDatabase(filename, (db) =>
						seedMatchingSessions(db, MAX_PURGEABLE_SKELETON_SESSIONS + 1),
					),
				),
			),
		),
	);

	it.effect("purges exactly the safety threshold", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(migrationsThroughPurge);
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{
				count: number;
			}>`SELECT COUNT(*) AS count FROM sessions`;
			expect(rows[0]?.count).toBe(0);
		}).pipe(
			Effect.provide(
				makeFileSqlLayer((filename) =>
					seedDatabase(filename, (db) =>
						seedMatchingSessions(db, MAX_PURGEABLE_SKELETON_SESSIONS),
					),
				),
			),
		),
	);

	it.effect("records migration 10 when the circuit breaker trips", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(migrationsThroughPurge);
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{ migration_id: number }>`
				SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`;
			expect(rows.map((row) => row.migration_id)).toContain(10);
		}).pipe(
			Effect.provide(
				makeFileSqlLayer((filename) =>
					seedDatabase(filename, (db) =>
						seedMatchingSessions(db, MAX_PURGEABLE_SKELETON_SESSIONS + 1),
					),
				),
			),
		),
	);

	it.effect("allows a later migration after the circuit breaker trips", () =>
		Effect.gen(function* () {
			const probeMigration = Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE purge_probe (id INTEGER PRIMARY KEY)`;
			});
			yield* makeEffectSqlMigrator(migrationsThroughPurge);
			yield* makeEffectSqlMigrator({
				...migrationsThroughPurge,
				"0011_probe": probeMigration,
			});

			const sql = yield* SqlClient.SqlClient;
			const probe = yield* sql<{ name: string }>`
				SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'purge_probe'`;
			const history = yield* sql<{ migration_id: number }>`
				SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`;
			expect(probe).toEqual([{ name: "purge_probe" }]);
			expect(history.map((row) => row.migration_id)).toContain(11);
		}).pipe(
			Effect.provide(
				makeFileSqlLayer((filename) =>
					seedDatabase(filename, (db) =>
						seedMatchingSessions(db, MAX_PURGEABLE_SKELETON_SESSIONS + 1),
					),
				),
			),
		),
	);
});
