import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";

// A fresh in-memory store per test, migrated the way production migrates it.
const migratedStore = Layer.effectDiscard(makeEffectSqlMigrator()).pipe(
	Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
);
const T = 1_000_000_000_000;

describe("Schema Migration", () => {
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
		}).pipe(Effect.provide(migratedStore)),
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
					name: "idx_activities_session_created",
					table: "activities",
					unique: false,
				},
				{
					name: "idx_activities_session_kind",
					table: "activities",
					unique: false,
				},
				{ name: "idx_activities_tone", table: "activities", unique: false },
				{ name: "idx_activities_turn", table: "activities", unique: false },
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
					name: "idx_events_session_version",
					table: "events",
					unique: true,
				},
				{ name: "idx_events_type", table: "events", unique: false },
				{
					name: "idx_message_parts_message",
					table: "message_parts",
					unique: false,
				},
				{
					name: "idx_messages_session_created",
					table: "messages",
					unique: false,
				},
				{ name: "idx_messages_turn", table: "messages", unique: false },
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
					name: "idx_provider_command_outbox_status",
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
					name: "idx_session_providers_active",
					table: "session_providers",
					unique: false,
				},
				{
					name: "idx_session_providers_session",
					table: "session_providers",
					unique: false,
				},
				{ name: "idx_sessions_parent", table: "sessions", unique: false },
				{
					name: "idx_sessions_provider",
					table: "sessions",
					unique: false,
				},
				{ name: "idx_sessions_updated", table: "sessions", unique: false },
				{
					name: "idx_tool_content_session",
					table: "tool_content",
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
			]);
		}).pipe(Effect.provide(migratedStore)),
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
			]);
		}).pipe(Effect.provide(migratedStore)),
	);

	it.effect("enforces unique event_id", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES ('s1', 'opencode', 'Test', 'idle', ${T}, ${T})`;
			yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				VALUES ('evt-1', 's1', 0, 'session.created', '{}', 'opencode', ${T})`;
			const duplicate = yield* Effect.either(
				sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				VALUES ('evt-1', 's1', 1, 'session.created', '{}', 'opencode', ${T})`,
			);
			expect(duplicate._tag).toBe("Left");
		}).pipe(Effect.provide(migratedStore)),
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
				const conflict = yield* Effect.either(
					sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				VALUES ('evt-2', 's1', 0, 'text.delta', '{}', 'opencode', ${T})`,
				);
				expect(conflict._tag).toBe("Left");
			}).pipe(Effect.provide(migratedStore)),
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
		}).pipe(Effect.provide(migratedStore)),
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
		}).pipe(Effect.provide(migratedStore)),
	);

	it.effect("is idempotent — running twice applies nothing", () =>
		Effect.gen(function* () {
			expect(yield* makeEffectSqlMigrator()).toEqual([]);
		}).pipe(Effect.provide(migratedStore)),
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
			}).pipe(Effect.provide(migratedStore)),
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
				const deleted = yield* Effect.either(
					sql`DELETE FROM sessions WHERE id = 's1'`,
				);
				expect(deleted._tag).toBe("Right");
				expect(
					yield* sql`SELECT event_id FROM events WHERE session_id = 's1'`,
				).toEqual([{ event_id: "evt-1" }]);
			}).pipe(Effect.provide(migratedStore)),
	);
});
