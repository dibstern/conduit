import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
export const SESSIONS_READ_AT_MIGRATION = "0011_sessions_read_at.sql";
export const SESSIONS_LAST_TURN_ERROR_MIGRATION =
	"0012_sessions_last_turn_error.sql";

export const BACKFILL_COMPACTION_MESSAGES_MIGRATION =
	"0013_backfill_compaction_messages.sql";

export const SESSIONS_SETTLED_PINNED_MIGRATION =
	"0014_sessions_settled_pinned.sql";
export const SESSIONS_SNOOZED_MIGRATION = "0015_sessions_snoozed.sql";
export const SESSIONS_AUTO_SETTLE_MIGRATION = "0016_sessions_auto_settle.sql";

export function readMigrationSql(filename: string): string {
	return readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "migrations", filename),
		"utf8",
	);
}
