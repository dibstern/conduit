import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration } from "./migrations.js";

export const CURRENT_EVENT_STORE_MIGRATION = "0001_current_event_store.sql";
export const MESSAGE_PART_METADATA_MIGRATION = "0002_message_part_metadata.sql";
export const DURABLE_PROVIDER_COMMANDS_MIGRATION =
	"0003_durable_provider_commands.sql";
export const DROP_EVENTS_SESSION_FK_MIGRATION =
	"0004_drop_events_session_fk.sql";
export const MESSAGE_PARTS_FILE_TYPE_MIGRATION =
	"0005_message_parts_file_type.sql";
export const MESSAGE_PARTS_COMPACTION_TYPE_MIGRATION =
	"0006_message_parts_compaction_type.sql";
export const MESSAGES_CONTEXT_WINDOW_MIGRATION =
	"0007_messages_context_window.sql";
export const TURN_MODEL_EXECUTION_MIGRATION = "0008_turn_model_execution.sql";
export const SESSIONS_PERMISSION_MODE_MIGRATION =
	"0009_sessions_permission_mode.sql";
export const SESSION_CASCADE_DELETES_MIGRATION =
	"0010_session_cascade_deletes.sql";
export const PROJECTION_FAILURES_MIGRATION = "0011_projection_failures.sql";
export const READ_MODEL_VERSION_MIGRATION = "0012_read_model_version.sql";
export const READ_MODEL_COUNTER_MIGRATION = "0013_read_model_counter.sql";
export const SESSIONS_LAST_VIEWED_AT_MIGRATION =
	"0014_sessions_last_viewed_at.sql";
export const SENT_ALERTS_MIGRATION = "0015_sent_alerts.sql";

export function readMigrationSql(filename: string): string {
	return readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "migrations", filename),
		"utf8",
	);
}

export const schemaMigrations: readonly Migration[] = [
	{
		id: 1,
		name: "create_event_store_tables",
		sql: readMigrationSql(CURRENT_EVENT_STORE_MIGRATION),
	},
	{
		id: 2,
		name: "add_message_part_metadata",
		sql: readMigrationSql(MESSAGE_PART_METADATA_MIGRATION),
	},
	{
		id: 3,
		name: "add_durable_provider_commands",
		sql: readMigrationSql(DURABLE_PROVIDER_COMMANDS_MIGRATION),
	},
	{
		id: 4,
		name: "drop_events_session_fk",
		sql: readMigrationSql(DROP_EVENTS_SESSION_FK_MIGRATION),
	},
	{
		id: 5,
		name: "message_parts_file_type",
		sql: readMigrationSql(MESSAGE_PARTS_FILE_TYPE_MIGRATION),
	},
	{
		id: 6,
		name: "message_parts_compaction_type",
		sql: readMigrationSql(MESSAGE_PARTS_COMPACTION_TYPE_MIGRATION),
	},
	{
		id: 7,
		name: "messages_context_window",
		sql: readMigrationSql(MESSAGES_CONTEXT_WINDOW_MIGRATION),
	},
	{
		id: 8,
		name: "turn_model_execution",
		sql: readMigrationSql(TURN_MODEL_EXECUTION_MIGRATION),
	},
	{
		id: 9,
		name: "sessions_permission_mode",
		sql: readMigrationSql(SESSIONS_PERMISSION_MODE_MIGRATION),
	},
	{
		id: 10,
		name: "session_cascade_deletes",
		sql: readMigrationSql(SESSION_CASCADE_DELETES_MIGRATION),
		rebuildsForeignKeys: true,
	},
	{
		id: 11,
		name: "create_projection_failures",
		sql: readMigrationSql(PROJECTION_FAILURES_MIGRATION),
	},
	{
		id: 12,
		name: "read_model_version",
		sql: readMigrationSql(READ_MODEL_VERSION_MIGRATION),
	},
	{
		id: 13,
		name: "read_model_counter",
		sql: readMigrationSql(READ_MODEL_COUNTER_MIGRATION),
	},
	{
		id: 14,
		name: "sessions_last_viewed_at",
		sql: readMigrationSql(SESSIONS_LAST_VIEWED_AT_MIGRATION),
	},
	{
		id: 15,
		name: "sent_alerts",
		sql: readMigrationSql(SENT_ALERTS_MIGRATION),
	},
];
