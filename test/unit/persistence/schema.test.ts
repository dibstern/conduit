import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

describe("Schema Migration", () => {
	let client: SqliteClient;

	afterEach(() => {
		client?.close();
	});

	it("creates all 12 tables", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		const tables = client
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.map((r) => r.name);
		expect(tables).toEqual([
			"activities",
			"command_receipts",
			"events",
			"message_parts",
			"messages",
			"pending_approvals",
			"projector_cursors",
			"provider_state",
			"session_providers",
			"sessions",
			"tool_content",
			"turns",
		]);
	});

	it("creates events table with correct columns", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		const columns = client
			.query<{ name: string; type: string; notnull: number; pk: number }>(
				"PRAGMA table_info(events)",
			)
			.map((c) => c.name);
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
	});

	it("enforces unique event_id", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		client.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
		client.execute(
			"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["evt-1", "s1", 0, "session.created", "{}", "opencode", Date.now()],
		);
		expect(() =>
			client.execute(
				"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["evt-1", "s1", 1, "session.created", "{}", "opencode", Date.now()],
			),
		).toThrow();
	});

	it("enforces unique (session_id, stream_version) for optimistic concurrency", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		client.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
		client.execute(
			"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["evt-1", "s1", 0, "session.created", "{}", "opencode", Date.now()],
		);
		expect(() =>
			client.execute(
				"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["evt-2", "s1", 0, "text.delta", "{}", "opencode", Date.now()],
			),
		).toThrow();
	});

	it("creates command_receipts table with correct columns", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		const columns = client
			.query<{ name: string }>("PRAGMA table_info(command_receipts)")
			.map((c) => c.name);
		expect(columns).toEqual([
			"command_id",
			"session_id",
			"status",
			"result_sequence",
			"error",
			"created_at",
		]);
	});

	it("creates projector_cursors table", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		const columns = client
			.query<{ name: string }>("PRAGMA table_info(projector_cursors)")
			.map((c) => c.name);
		expect(columns).toEqual([
			"projector_name",
			"last_applied_seq",
			"updated_at",
		]);
	});

	it("is idempotent — running twice produces no errors", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		const applied = runMigrations(client, schemaMigrations);
		expect(applied).toEqual([]);
	});

	it("uses RESTRICT (not CASCADE) for session foreign keys", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		client.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[
				"s1",
				"opencode",
				"Test Session",
				"idle",
				1_000_000_000_000,
				1_000_000_000_000,
			],
		);
		client.execute(
			"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				"evt-1",
				"s1",
				0,
				"session.created",
				"{}",
				"opencode",
				1_000_000_000_000,
			],
		);
		expect(() =>
			client.execute("DELETE FROM sessions WHERE id = ?", ["s1"]),
		).toThrow(/FOREIGN KEY constraint/);
	});

	it("events FK requires delete-dependents-first order for eviction", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		client.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[
				"s1",
				"opencode",
				"Test Session",
				"idle",
				1_000_000_000_000,
				1_000_000_000_000,
			],
		);
		client.execute(
			"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				"evt-1",
				"s1",
				0,
				"session.created",
				"{}",
				"opencode",
				1_000_000_000_000,
			],
		);
		client.execute("DELETE FROM events WHERE session_id = ?", ["s1"]);
		expect(() =>
			client.execute("DELETE FROM sessions WHERE id = ?", ["s1"]),
		).not.toThrow();
	});
});
