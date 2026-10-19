import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import {
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";

// A fresh in-memory store per test, migrated the way production migrates it.
const migratedStore = Layer.effectDiscard(makeEffectSqlMigrator()).pipe(
	Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
);
const T = 1_000_000_000_000;

describe("Schema Migration", () => {
	// Failure modes: existing stores miss the index, shelf predicates scan all
	// project rows, migration changes rows, or ledger repair cannot replay it.
	it.effect(
		"indexes settled shelf counts when upgrading an existing store",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(
					Object.fromEntries(
						Object.entries(effectMigrationEntries).slice(0, 69),
					),
				);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, project_id, title, provider, parent_id, settled_at, pinned_at, created_at, updated_at)
				VALUES ('root', 'alpha', 'Alpha Ö work', 'claude', NULL, 10, NULL, 1, 1),
				('active', 'alpha', 'Active', 'claude', NULL, NULL, NULL, 1, 1),
				('pinned', 'alpha', 'Pinned', 'claude', NULL, 10, 11, 1, 1),
				('child', 'alpha', 'Child', 'claude', 'root', 10, NULL, 1, 1),
				('other', 'beta', 'Other', 'claude', NULL, 10, NULL, 1, 1)`;
				expect(yield* makeEffectSqlMigrator()).toEqual([
					[70, "sessions_settled_shelf_index"],
					[71, "surfacing_marks"],
					[72, "message_part_read"],
					[73, "turn_recaps"],
				]);
				for (const [filter, count] of [
					["", 2],
					["AND parent_id IS NULL", 1],
					["AND parent_id IS NULL AND title LIKE '%Ö%' ESCAPE '\\'", 1],
					["AND parent_id IS NULL AND title LIKE '%ö%' ESCAPE '\\'", 0],
				] as const) {
					const query = `SELECT COUNT(*) AS count FROM sessions WHERE project_id IN ('alpha') AND settled_at IS NOT NULL AND pinned_at IS NULL ${filter}`;
					expect(yield* sql.unsafe(query)).toEqual([{ count }]);
					const plan = yield* sql.unsafe<{ detail: string }>(
						`EXPLAIN QUERY PLAN ${query}`,
					);
					expect(plan.map(({ detail }) => detail).join("\n")).toContain(
						"idx_sessions_settled_shelf",
					);
				}
				expect(yield* sql`SELECT COUNT(*) AS count FROM sessions`).toEqual([
					{ count: 5 },
				]);
				yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 70`;
				expect(yield* makeEffectSqlMigrator()).toEqual([
					[70, "sessions_settled_shelf_index"],
				]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	);

	// Guard the index with the launch-ownership lookup used by list reads.
	it.effect(
		"indexes launch ownership by session and event type when upgrading an existing store",
		() =>
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(
					Object.fromEntries(
						Object.entries(effectMigrationEntries).slice(0, 54),
					),
				);
				expect(yield* makeEffectSqlMigrator()).toEqual([
					[55, "events_session_type_index"],
					[56, "drop_activities"],
					[57, "session_pick_backfill"],
					[58, "compact_redundant_events"],
					[59, "session_project_scope"],
					[60, "daemon_store_imports"],
					[61, "sessions_lineage"],
					[62, "legacy_forks"],
					[63, "sessions_archived"],
					[64, "prompt_provider_reference"],
					[65, "tool_result_event_refs"],
					[66, "project_tree_data"],
					[67, "purge_background_shell_sessions"],
					[68, "goal_check_metadata"],
					[69, "message_part_surfacing"],
					[70, "sessions_settled_shelf_index"],
					[71, "surfacing_marks"],
					[72, "message_part_read"],
					[73, "turn_recaps"],
				]);
				const sql = yield* SqlClient.SqlClient;
				const plan = yield* sql<{ detail: string }>`
				EXPLAIN QUERY PLAN
				SELECT EXISTS(SELECT 1 FROM events WHERE session_id = 'launched-session'
					AND type = 'session.workspace_changed' AND json_extract(data, '$.cause') = 'launch'
					AND json_extract(data, '$.origin') = 'conduit'
					AND json_array_length(data, '$.ownership') > 0) AS owned`;
				expect(plan.map(({ detail }) => detail)).toContain(
					"SEARCH events USING INDEX idx_events_session_type (session_id=? AND type=?)",
				);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	);

	it.effect("creates all durable event-store tables", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const tables = (yield* sql<{ name: string }>`
					SELECT name FROM sqlite_master
					WHERE type='table'
						AND name NOT LIKE 'sqlite_%'
						AND name != 'effect_sql_migrations'
					ORDER BY name`).map((r) => r.name);
			expect(tables).toEqual([
				"command_receipts",
				"daemon_store_imports",
				"events",
				"message_part_read_state",
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
				"surfacing_marks",
				"tool_content",
				"turn_recaps",
				"turns",
			]);
		}).pipe(Effect.provide(migratedStore, { local: true })),
	);

	it.effect(
		"records a project import and its number-domain offsets atomically",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const columns = yield* sql<{
					name: string;
					notnull: number;
					pk: number;
				}>`PRAGMA table_info(daemon_store_imports)`;
				expect(columns.map(({ name }) => name)).toEqual([
					"project_id",
					"method",
					"source_path",
					"source_fingerprint",
					"event_offset",
					"outbox_offset",
					"version_offset",
					"rowid_offsets",
					"completed_at",
				]);
				expect(columns.find(({ name }) => name === "project_id")?.pk).toBe(1);
				expect(columns.every(({ notnull }) => notnull === 1)).toBe(true);
				yield* sql`INSERT INTO daemon_store_imports VALUES ('alpha', 'seeded', 'source.db', '{}', 0, 0, 0, '{}', 1000)`;
				expect(
					(yield* sql`SELECT method FROM daemon_store_imports WHERE project_id = 'alpha'`)[0],
				).toEqual({ method: "seeded" });
			}).pipe(Effect.provide(migratedStore, { local: true })),
	);

	it.effect("creates the full production index inventory", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const indexes = (yield* sql<{
				name: string;
				tbl_name: string;
				sql: string | null;
			}>`
					SELECT name, tbl_name, sql
					FROM sqlite_master
					WHERE type='index' AND name NOT LIKE 'sqlite_%'
					ORDER BY name`).map((row) => ({
				name: row.name,
				table: row.tbl_name,
				unique: row.sql?.startsWith("CREATE UNIQUE INDEX") ?? false,
			}));
			expect(indexes).toEqual([
				{
					name: "idx_command_receipts_project",
					table: "command_receipts",
					unique: false,
				},
				{
					name: "idx_command_receipts_session",
					table: "command_receipts",
					unique: false,
				},
				{
					name: "idx_events_session_seq",
					table: "events",
					unique: false,
				},
				{
					name: "idx_events_session_type",
					table: "events",
					unique: false,
				},
				{
					name: "idx_events_session_version",
					table: "events",
					unique: true,
				},
				{ name: "idx_events_type", table: "events", unique: false },
				{ name: "idx_events_unstamped", table: "events", unique: false },
				{
					name: "idx_message_part_tombstones_session_version",
					table: "message_part_tombstones",
					unique: false,
				},
				{
					name: "idx_message_parts_message",
					table: "message_parts",
					unique: false,
				},
				{
					name: "idx_message_parts_open_questions",
					table: "message_parts",
					unique: false,
				},
				{
					name: "idx_message_parts_tool_call",
					table: "message_parts",
					unique: false,
				},
				{
					name: "idx_message_parts_version",
					table: "message_parts",
					unique: false,
				},
				{
					name: "idx_message_tombstones_session_version",
					table: "message_tombstones",
					unique: false,
				},
				{ name: "idx_messages_input_id", table: "messages", unique: false },
				{
					name: "idx_messages_session_created",
					table: "messages",
					unique: false,
				},
				{ name: "idx_messages_turn", table: "messages", unique: false },
				{ name: "idx_messages_version", table: "messages", unique: false },
				{
					name: "idx_pending_approvals_pending",
					table: "pending_approvals",
					unique: false,
				},
				{
					name: "idx_pending_approvals_session_status",
					table: "pending_approvals",
					unique: false,
				},
				{
					name: "idx_pending_approvals_version",
					table: "pending_approvals",
					unique: false,
				},
				{
					name: "idx_pending_inputs_session_version",
					table: "pending_inputs",
					unique: false,
				},
				{
					name: "idx_provider_command_outbox_status",
					table: "provider_command_outbox",
					unique: false,
				},
				{
					name: "idx_provider_command_outbox_turn_settings",
					table: "provider_command_outbox",
					unique: false,
				},
				{
					name: "idx_provider_command_tombstones_session",
					table: "provider_command_tombstones",
					unique: false,
				},
				{
					name: "idx_provider_command_turns_session",
					table: "provider_command_turns",
					unique: false,
				},
				{
					name: "idx_session_goal_checks_session_created",
					table: "session_goal_checks",
					unique: false,
				},
				{
					name: "idx_session_providers_active",
					table: "session_providers",
					unique: false,
				},
				{
					name: "idx_session_providers_session",
					table: "session_providers",
					unique: false,
				},
				{
					name: "idx_session_sidebar_project_activity",
					table: "session_sidebar",
					unique: false,
				},
				{
					name: "idx_session_sidebar_project_version",
					table: "session_sidebar",
					unique: false,
				},
				{
					name: "idx_session_sidebar_version",
					table: "session_sidebar",
					unique: false,
				},
				{ name: "idx_sessions_forked_from", table: "sessions", unique: false },
				{ name: "idx_sessions_parent", table: "sessions", unique: false },
				{
					name: "idx_sessions_project_status",
					table: "sessions",
					unique: false,
				},
				{
					name: "idx_sessions_project_updated",
					table: "sessions",
					unique: false,
				},
				{
					name: "idx_sessions_provider",
					table: "sessions",
					unique: false,
				},
				{ name: "idx_sessions_root", table: "sessions", unique: false },
				{
					name: "idx_sessions_settled_shelf",
					table: "sessions",
					unique: false,
				},
				{ name: "idx_sessions_updated", table: "sessions", unique: false },
				{ name: "idx_sessions_version", table: "sessions", unique: false },
				{
					name: "idx_tool_content_session",
					table: "tool_content",
					unique: false,
				},
				{
					name: "idx_turn_recaps_session",
					table: "turn_recaps",
					unique: false,
				},
				{
					name: "idx_turns_assistant_message",
					table: "turns",
					unique: false,
				},
				{
					name: "idx_turns_session_requested",
					table: "turns",
					unique: false,
				},
				{
					name: "pending_approvals_provider_request",
					table: "pending_approvals",
					unique: true,
				},
			]);
		}).pipe(Effect.provide(migratedStore, { local: true })),
	);

	it.effect("creates events table with correct columns", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const columns = (yield* sql<{
				name: string;
			}>`PRAGMA table_info(events)`).map((c) => c.name);
			expect(columns).toEqual([
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
		}).pipe(Effect.provide(migratedStore, { local: true })),
	);

	it.effect("enforces unique event_id", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES ('s1', 'opencode', 'Test', 'idle', ${T}, ${T})`;
			yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				VALUES ('evt-1', 's1', 0, 'session.created', '{}', 'opencode', ${T})`;
			const duplicate = yield* Effect.result(
				sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				VALUES ('evt-1', 's1', 1, 'session.created', '{}', 'opencode', ${T})`,
			);
			expect(duplicate._tag).toBe("Failure");
		}).pipe(Effect.provide(migratedStore, { local: true })),
	);

	it.effect(
		"enforces unique (session_id, stream_version) for optimistic concurrency",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES ('s1', 'opencode', 'Test', 'idle', ${T}, ${T})`;
				yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				VALUES ('evt-1', 's1', 0, 'session.created', '{}', 'opencode', ${T})`;
				const conflict = yield* Effect.result(
					sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				VALUES ('evt-2', 's1', 0, 'text.delta', '{}', 'opencode', ${T})`,
				);
				expect(conflict._tag).toBe("Failure");
			}).pipe(Effect.provide(migratedStore, { local: true })),
	);

	it.effect("creates command_receipts table with correct columns", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const columns = (yield* sql<{
				name: string;
			}>`PRAGMA table_info(command_receipts)`).map((c) => c.name);
			expect(columns).toEqual([
				"command_id",
				"session_id",
				"status",
				"result_sequence",
				"error",
				"created_at",
				"command_type",
				"project_key",
				"fingerprint_hash",
				"fingerprint_version",
				"accepted_sequence",
				"side_effect_sequence",
				"error_code",
				"updated_at",
			]);
		}).pipe(Effect.provide(migratedStore, { local: true })),
	);

	it.effect("creates projector_cursors table", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const columns = (yield* sql<{
				name: string;
			}>`PRAGMA table_info(projector_cursors)`).map((c) => c.name);
			expect(columns).toEqual([
				"projector_name",
				"last_applied_seq",
				"updated_at",
			]);
		}).pipe(Effect.provide(migratedStore, { local: true })),
	);

	it.effect("is idempotent — running twice applies nothing", () =>
		Effect.gen(function* () {
			expect(yield* makeEffectSqlMigrator()).toEqual([]);
		}).pipe(Effect.provide(migratedStore, { local: true })),
	);

	it.effect(
		"does not require a session projection row before appending events",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				VALUES ('evt-1', 's1', 0, 'session.created', '{}', 'opencode', ${T})`;
				expect(
					yield* sql`SELECT session_id FROM events WHERE event_id = 'evt-1'`,
				).toEqual([{ session_id: "s1" }]);
			}).pipe(Effect.provide(migratedStore, { local: true })),
	);

	it.effect(
		"keeps durable events independent from session projection deletion",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES ('s1', 'opencode', 'Test', 'idle', ${T}, ${T})`;
				yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				VALUES ('evt-1', 's1', 0, 'session.created', '{}', 'opencode', ${T})`;
				const deleted = yield* Effect.result(
					sql`DELETE FROM sessions WHERE id = 's1'`,
				);
				expect(deleted._tag).toBe("Success");
				expect(
					yield* sql`SELECT event_id FROM events WHERE session_id = 's1'`,
				).toEqual([{ event_id: "evt-1" }]);
			}).pipe(Effect.provide(migratedStore, { local: true })),
	);
});
