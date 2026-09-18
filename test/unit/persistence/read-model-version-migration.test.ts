import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

describe("read-model version migration", () => {
	it("upgrades an existing Effect database and preserves versions on rerun", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(
					Object.fromEntries(
						Object.entries(effectMigrationEntries).filter(
							([key]) => key < "0013",
						),
					),
				);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('s', 'claude', 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, text, last_applied_seq, created_at, updated_at) VALUES ('m', 's', 'assistant', 'preserved', 7, 1, 1)`;
				yield* sql`INSERT INTO projector_cursors (projector_name, last_applied_seq, updated_at) VALUES ('session', 10, 1), ('message', 10, 1)`;
				yield* sql`INSERT INTO events (sequence, event_id, session_id, stream_version, type, data, provider, created_at) VALUES (10, 'e', 's', 1, 'text.delta', '{}', 'claude', 1)`;
				yield* makeEffectSqlMigrator();
				expect(yield* sql`PRAGMA table_info(sessions)`).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "version" }),
					]),
				);
				expect(yield* sql`SELECT id, version FROM sessions`).toEqual([
					{ id: "s", version: 10 },
				]);
				expect(yield* sql`SELECT id, version, text FROM messages`).toEqual([
					{ id: "m", version: 10, text: "preserved" },
				]);
				for (const table of ["sessions", "messages"]) {
					expect(
						yield* sql.unsafe(`PRAGMA index_info(idx_${table}_version)`),
					).toEqual(
						table === "messages"
							? [
									expect.objectContaining({ name: "session_id", seqno: 0 }),
									expect.objectContaining({ name: "version", seqno: 1 }),
								]
							: [expect.objectContaining({ name: "version", seqno: 0 })],
					);
				}
				yield* sql`UPDATE messages SET version = 15 WHERE id = 'm'`;
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
				expect(yield* sql`SELECT version FROM messages`).toEqual([
					{ version: 15 },
				]);
			}).pipe(
				Effect.provide(EffectSqliteClient.layer({ filename: ":memory:" })),
			),
		);
	});

	it("backfills indexed versions without replaying events or resetting cursors", () => {
		const db = SqliteClient.memory();
		try {
			runMigrations(
				db,
				schemaMigrations.filter((migration) => migration.id < 12),
			);
			db.exec(`
				INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES
					('recent', 'claude', 'Kept title', 1, 1),
					('evicted', 'claude', 'Old title', 1, 1),
					('unknown', 'claude', 'No history', 1, 1);
				INSERT INTO messages (id, session_id, role, text, last_applied_seq, created_at, updated_at) VALUES
					('recent-message', 'recent', 'assistant', 'Kept text', 10, 1, 1),
					('evicted-message', 'evicted', 'assistant', 'Old text', 7, 1, 1),
					('unknown-message', 'unknown', 'user', 'No history', NULL, 1, 1);
				INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
					VALUES ('part', 'recent-message', 'text', 'Kept text', 0, 1, 1);
				INSERT INTO projector_cursors (projector_name, last_applied_seq, updated_at) VALUES
					('session', 30, 1), ('message', 20, 1);
				INSERT INTO events (sequence, event_id, session_id, stream_version, type, data, provider, created_at) VALUES
					(10, 'e10', 'recent', 1, 'message.created', '{}', 'claude', 1),
					(20, 'e20', 'recent', 2, 'tool.completed', '{}', 'claude', 1),
					(30, 'e30', 'recent', 3, 'session.renamed', '{}', 'claude', 1),
					(40, 'e40', 'recent', 4, 'message.created', '{}', 'claude', 1);
			`);
			const cursors = db.query(
				"SELECT * FROM projector_cursors ORDER BY projector_name",
			);
			const events = db.query("SELECT * FROM events ORDER BY sequence");

			runMigrations(db, schemaMigrations);

			for (const table of ["sessions", "messages"]) {
				expect(db.query(`PRAGMA table_info(${table})`)).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							name: "version",
							type: "INTEGER",
							notnull: 1,
							dflt_value: "0",
						}),
					]),
				);
				expect(db.query(`PRAGMA index_info(idx_${table}_version)`)).toEqual(
					table === "messages"
						? [
								expect.objectContaining({ name: "session_id", seqno: 0 }),
								expect.objectContaining({ name: "version", seqno: 1 }),
							]
						: [expect.objectContaining({ name: "version", seqno: 0 })],
				);
				expect(
					db.query<{ detail: string }>(
						table === "messages"
							? "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE session_id = ? AND version > ?"
							: "EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE version > ?",
						table === "messages" ? ["recent", 15] : [15],
					)[0]?.detail,
				).toContain(
					table === "messages"
						? "idx_messages_version (session_id=? AND version>?)"
						: "idx_sessions_version (version>?)",
				);
			}
			expect(db.query("SELECT id, version FROM sessions ORDER BY id")).toEqual([
				{ id: "evicted", version: 0 },
				{ id: "recent", version: 30 },
				{ id: "unknown", version: 0 },
			]);
			expect(db.query("SELECT id, version FROM messages ORDER BY id")).toEqual([
				{ id: "evicted-message", version: 7 },
				{ id: "recent-message", version: 20 },
				{ id: "unknown-message", version: 0 },
			]);
			expect(
				db.query("SELECT id FROM messages WHERE version > ?", [15]),
			).toEqual([{ id: "recent-message" }]);
			expect(
				db.query("SELECT * FROM projector_cursors ORDER BY projector_name"),
			).toEqual(cursors);
			expect(db.query("SELECT * FROM events ORDER BY sequence")).toEqual(
				events,
			);
			expect(
				db.queryOne("SELECT title FROM sessions WHERE id = 'recent'"),
			).toEqual({ title: "Kept title" });
			expect(
				db.queryOne("SELECT text FROM message_parts WHERE id = 'part'"),
			).toEqual({ text: "Kept text" });
			expect(runMigrations(db, schemaMigrations)).toEqual([]);
		} finally {
			db.close();
		}
	});
});
