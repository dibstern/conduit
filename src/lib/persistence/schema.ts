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
];
