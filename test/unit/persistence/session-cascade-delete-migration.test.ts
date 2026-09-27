import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import Database from "better-sqlite3";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import { seedLegacyEventStore } from "../../helpers/legacy-event-store.js";

const parentId = "parent";
const childId = "child";
const projectionTables = [
	"sessions",
	"turns",
	"messages",
	"message_parts",
	"session_providers",
	"pending_approvals",
	"activities",
	"tool_content",
	"provider_state",
] as const;

function seedLegacyDatabase(filename: string): void {
	const db = new Database(filename);
	try {
		seedLegacyEventStore(db, 9);
		for (const sessionId of [parentId, childId]) {
			const turnId = `${sessionId}-turn`;
			const messageId = `${sessionId}-message`;
			db.prepare(`INSERT INTO sessions (id, provider, parent_id, created_at, updated_at)
				 VALUES (?, 'opencode', ?, 100, 100)`).run([
				sessionId,
				sessionId === childId ? parentId : null,
			]);
			db.prepare(
				"INSERT INTO turns (id, session_id, requested_at) VALUES (?, ?, 100)",
			).run([turnId, sessionId]);
			db.prepare(`INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at)
				 VALUES (?, ?, ?, 'user', 'hello', 100, 100)`).run([
				messageId,
				sessionId,
				turnId,
			]);
			db.prepare(`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				 VALUES (?, ?, 'text', 'hello', 0, 100, 100)`).run([
				`${sessionId}-part`,
				messageId,
			]);
			db.prepare(`INSERT INTO pending_approvals (id, session_id, turn_id, type, created_at)
				 VALUES (?, ?, ?, 'permission', 100)`).run([
				`${sessionId}-approval`,
				sessionId,
				turnId,
			]);
			db.prepare(`INSERT INTO activities (id, session_id, turn_id, tone, kind, summary, created_at)
				 VALUES (?, ?, ?, 'info', 'tool', 'Running tool', 100)`).run([
				`${sessionId}-activity`,
				sessionId,
				turnId,
			]);
			db.prepare(`INSERT INTO session_providers (id, session_id, provider, activated_at)
				 VALUES (?, ?, 'opencode', 100)`).run([
				`${sessionId}-provider`,
				sessionId,
			]);
			db.prepare(`INSERT INTO tool_content (tool_id, session_id, content, created_at)
				 VALUES (?, ?, 'tool output', 100)`).run([
				`${sessionId}-tool`,
				sessionId,
			]);
			db.prepare(
				"INSERT INTO provider_state (session_id, key, value) VALUES (?, 'state', '{}')",
			).run([sessionId]);
			db.prepare(`INSERT INTO events (event_id, session_id, stream_version, type, data, metadata, provider, created_at)
				 VALUES (?, ?, 0, 'session.status', ?, '{}', 'opencode', 100)`).run([
				`${sessionId}-event`,
				sessionId,
				JSON.stringify({ sessionId, status: "idle" }),
			]);
		}
	} finally {
		db.close();
	}
}

describe("session cascade delete migration", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("migrates live legacy rows and cascades parent deletion while preserving events", async () => {
		dir = mkdtempSync(join(tmpdir(), "conduit-session-cascade-migration-"));
		const filename = join(dir, "events.db");
		seedLegacyDatabase(filename);
		const runtime = ManagedRuntime.make(makePersistenceEffectLayer(filename));

		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					expect(yield* sql`PRAGMA foreign_keys`).toEqual([
						{ foreign_keys: 1 },
					]);
					const sessionsSchema = yield* sql<{
						sql: string;
					}>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`;
					expect(sessionsSchema).toHaveLength(1);
					// The migration declares the self-referential parent_id FK against the
					// FINAL table name ("sessions"), not "sessions_new", because whether
					// ALTER TABLE ... RENAME TO rewrites an unqualified self-reference
					// depends on the legacy_alter_table pragma (on by default under the
					// sqlite3 CLI, off under better-sqlite3). Asserting against the actual
					// schema text -- rather than trusting that a rename rewrite happened --
					// is the only way to catch a regression here. Comments in the DDL text
					// are stripped first since sqlite_master preserves them verbatim and
					// this file's own explanatory comment mentions "sessions_new".
					const schemaWithoutComments = (sessionsSchema[0]?.sql ?? "")
						.split("\n")
						.filter((line) => !line.trim().startsWith("--"))
						.join("\n");
					expect(schemaWithoutComments).toContain("REFERENCES sessions(id)");
					expect(schemaWithoutComments).not.toContain("sessions_new");
					for (const table of projectionTables) {
						const rows = yield* sql.unsafe(`SELECT * FROM ${table}`);
						expect(rows, `${table} survives migration`).toHaveLength(2);
					}

					yield* sql`DELETE FROM sessions WHERE id = ${parentId}`;

					for (const table of projectionTables) {
						const rows = yield* sql.unsafe(`SELECT * FROM ${table}`);
						expect(rows, `${table} cascades parent and child rows`).toEqual([]);
					}
					expect(
						yield* sql`SELECT event_id, session_id FROM events ORDER BY session_id`,
					).toEqual([
						{ event_id: "child-event", session_id: childId },
						{ event_id: "parent-event", session_id: parentId },
					]);
					expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
					expect(yield* makeEffectSqlMigrator()).toEqual([]);
				}),
			);
		} finally {
			await runtime.dispose();
		}
	});
});
