import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration } from "./migrations.js";

export const CURRENT_EVENT_STORE_MIGRATION = "0001_current_event_store.sql";
export const MESSAGE_PART_METADATA_MIGRATION = "0002_message_part_metadata.sql";

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
];
