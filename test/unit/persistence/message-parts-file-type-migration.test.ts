// ─── message_parts file-type migration (0005) ───────────────────────────────
// Legacy databases created before 0005 have
// CHECK(type IN ('text', 'thinking', 'tool')) on message_parts, which rejects
// the file parts persisted by the file.attached canonical event. 0005 rebuilds
// the table with 'file' allowed, preserving all rows including 0002's
// metadata column.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	CURRENT_EVENT_STORE_MIGRATION,
	MESSAGE_PART_METADATA_MIGRATION,
	readMigrationSql,
} from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

const SESSION_ID = "legacy-session";
const MESSAGE_ID = "legacy-message";

function seedLegacyDatabase(filename: string): void {
	const db = SqliteClient.open(filename);
	try {
		// 0001 + 0002 exactly as a pre-0005 database ran them: the old
		// three-value CHECK plus the appended metadata column.
		db.exec(readMigrationSql(CURRENT_EVENT_STORE_MIGRATION));
		db.exec(readMigrationSql(MESSAGE_PART_METADATA_MIGRATION));
		db.exec(`
			CREATE TABLE effect_sql_migrations (
				migration_id INTEGER PRIMARY KEY NOT NULL,
				created_at DATETIME NOT NULL DEFAULT current_timestamp,
				name VARCHAR(255) NOT NULL
			);
			INSERT INTO effect_sql_migrations (migration_id, name) VALUES
				(1, 'create_event_store_tables'),
				(2, 'add_message_part_metadata');
		`);
		db.execute(
			`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
			 VALUES (?, 'opencode', 'Legacy', 'idle', 100, 100)`,
			[SESSION_ID],
		);
		db.execute(
			`INSERT INTO messages (id, session_id, role, text, created_at, updated_at)
			 VALUES (?, ?, 'assistant', 'hello', 100, 100)`,
			[MESSAGE_ID, SESSION_ID],
		);
		db.execute(
			`INSERT INTO message_parts
			 (id, message_id, type, text, tool_name, call_id, status, metadata,
			  sort_order, created_at, updated_at)
			 VALUES ('legacy-part', ?, 'tool', '', 'Bash', 'call-1', 'completed',
			         '{"sessionId":"ses_child"}', 0, 100, 100)`,
			[MESSAGE_ID],
		);
		expect(() =>
			db.execute(
				`INSERT INTO message_parts
				 (id, message_id, type, sort_order, created_at, updated_at)
				 VALUES ('pre-migration-file', ?, 'file', 1, 100, 100)`,
				[MESSAGE_ID],
			),
		).toThrow(/CHECK/);
		// FK-outage era leftovers: parts whose messages row never landed. These
		// were written by connections without foreign-key enforcement and are
		// unreadable (every query path joins through messages); the migration
		// must drop them instead of failing the rebuild's FK check.
		db.exec("PRAGMA foreign_keys=OFF");
		db.execute(
			`INSERT INTO message_parts
			 (id, message_id, type, text, sort_order, created_at, updated_at)
			 VALUES ('orphan-part', 'missing-message', 'text', 'orphan', 0, 100, 100)`,
		);
		db.exec("PRAGMA foreign_keys=ON");
	} finally {
		db.close();
	}
}

describe("message_parts file-type migration", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("preserves rows and permits type='file' after upgrading a legacy database", async () => {
		dir = mkdtempSync(join(tmpdir(), "conduit-parts-file-migration-"));
		const filename = join(dir, "events.db");
		seedLegacyDatabase(filename);

		const runtime = ManagedRuntime.make(makePersistenceEffectLayer(filename));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;

					const preserved = yield* sql<{
						id: string;
						type: string;
						tool_name: string;
						metadata: string;
					}>`SELECT id, type, tool_name, metadata FROM message_parts
					   ORDER BY sort_order`;
					// The orphan part is dropped; the valid row survives intact.
					expect(preserved).toEqual([
						{
							id: "legacy-part",
							type: "tool",
							tool_name: "Bash",
							metadata: '{"sessionId":"ses_child"}',
						},
					]);

					yield* sql`INSERT INTO message_parts
						(id, message_id, type, metadata, sort_order, created_at, updated_at)
						VALUES ('file-part', ${MESSAGE_ID}, 'file',
						        '{"mime":"image/png","url":"data:image/png;base64,AAAA"}',
						        1, 200, 200)`;

					const filePart = yield* sql<{ type: string }>`
						SELECT type FROM message_parts WHERE id = 'file-part'`;
					expect(filePart).toEqual([{ type: "file" }]);
				}),
			);
		} finally {
			await runtime.dispose();
		}
	});
});
