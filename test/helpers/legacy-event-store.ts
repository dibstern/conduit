// Builds an event store the way the retired synchronous runner left it, so tests
// can prove the Effect migrator still adopts stores that exist in the wild.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
	BACKFILL_COMPACTION_MESSAGES_MIGRATION,
	CURRENT_EVENT_STORE_MIGRATION,
	DROP_EVENTS_SESSION_FK_MIGRATION,
	DURABLE_PROVIDER_COMMANDS_MIGRATION,
	MESSAGE_PART_METADATA_MIGRATION,
	MESSAGE_PARTS_COMPACTION_TYPE_MIGRATION,
	MESSAGE_PARTS_FILE_TYPE_MIGRATION,
	MESSAGES_CONTEXT_WINDOW_MIGRATION,
	readMigrationSql,
	SESSION_CASCADE_DELETES_MIGRATION,
	SESSIONS_LAST_TURN_ERROR_MIGRATION,
	SESSIONS_PERMISSION_MODE_MIGRATION,
	SESSIONS_READ_AT_MIGRATION,
	TURN_MODEL_EXECUTION_MIGRATION,
} from "../../src/lib/persistence/schema.js";

/** The legacy `_migrations` registry, in id order. */
export const legacyMigrations = [
	{ name: "create_event_store_tables", file: CURRENT_EVENT_STORE_MIGRATION },
	{ name: "add_message_part_metadata", file: MESSAGE_PART_METADATA_MIGRATION },
	{
		name: "add_durable_provider_commands",
		file: DURABLE_PROVIDER_COMMANDS_MIGRATION,
	},
	{ name: "drop_events_session_fk", file: DROP_EVENTS_SESSION_FK_MIGRATION },
	{ name: "message_parts_file_type", file: MESSAGE_PARTS_FILE_TYPE_MIGRATION },
	{
		name: "message_parts_compaction_type",
		file: MESSAGE_PARTS_COMPACTION_TYPE_MIGRATION,
	},
	{ name: "messages_context_window", file: MESSAGES_CONTEXT_WINDOW_MIGRATION },
	{ name: "turn_model_execution", file: TURN_MODEL_EXECUTION_MIGRATION },
	{
		name: "sessions_permission_mode",
		file: SESSIONS_PERMISSION_MODE_MIGRATION,
	},
	{ name: "session_cascade_deletes", file: SESSION_CASCADE_DELETES_MIGRATION },
	{ name: "sessions_read_at", file: SESSIONS_READ_AT_MIGRATION },
	{
		name: "sessions_last_turn_error",
		file: SESSIONS_LAST_TURN_ERROR_MIGRATION,
	},
	{
		name: "backfill_compaction_messages",
		file: BACKFILL_COMPACTION_MESSAGES_MIGRATION,
	},
].map((migration, index) => ({ id: index + 1, ...migration }));

/** Legacy id 10 rebuilds `sessions`, which needs foreign keys off. */
const REBUILDS_FOREIGN_KEYS_ID = 10;

/** Applies legacy migrations 1..`through` and records them in `_migrations`. */
export function seedLegacyEventStore(
	db: Database.Database,
	through = legacyMigrations.length,
): void {
	db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		checksum TEXT NOT NULL,
		applied_at INTEGER NOT NULL
	)`);
	const record = db.prepare(
		"INSERT INTO _migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
	);
	for (const { id, name, file } of legacyMigrations.slice(0, through)) {
		const sql = readMigrationSql(file);
		const rebuildsForeignKeys = id === REBUILDS_FOREIGN_KEYS_ID;
		// PRAGMA foreign_keys is a no-op inside a transaction.
		if (rebuildsForeignKeys) db.pragma("foreign_keys = OFF");
		db.transaction(() => {
			db.exec(sql);
			if (rebuildsForeignKeys) {
				const violations = db.pragma("foreign_key_check");
				if (Array.isArray(violations) && violations.length > 0) {
					throw new Error(`Legacy migration ${id} broke foreign keys`);
				}
			}
			record.run(
				id,
				name,
				createHash("sha256").update(sql).digest("hex"),
				Date.now(),
			);
		})();
		if (rebuildsForeignKeys) db.pragma("foreign_keys = ON");
	}
}
