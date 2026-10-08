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
export const PROJECTION_FAILURES_MIGRATION = "0017_projection_failures.sql";
export const READ_MODEL_VERSION_MIGRATION = "0018_read_model_version.sql";
export const READ_MODEL_COUNTER_MIGRATION = "0019_read_model_counter.sql";
export const SENT_ALERTS_MIGRATION = "0020_sent_alerts.sql";
export const FORK_POINT_TIMESTAMP_MIGRATION = "0021_fork_point_timestamp.sql";
export const SESSIONS_MARKED_UNREAD_MIGRATION =
	"0022_sessions_marked_unread.sql";
export const SESSION_ATTENTION_MIGRATION = "0023_session_attention.sql";
export const READ_STATE_TO_TURN_ENDS_MIGRATION =
	"0024_read_state_to_turn_ends.sql";
export const SESSIONS_FORKED_FROM_MIGRATION = "0025_sessions_forked_from.sql";
export const MESSAGES_BACKFILLED_MIGRATION = "0026_messages_backfilled.sql";
export const SESSIONS_HISTORY_COMPLETE_MIGRATION =
	"0027_sessions_history_complete.sql";
export const MESSAGE_TOMBSTONES_MIGRATION = "0028_message_tombstones.sql";
export const SESSION_GOALS_MIGRATION = "0029_session_goals.sql";
export const STARTUP_RESTORE_INDEXES_MIGRATION =
	"0030_startup_restore_indexes.sql";
export const TOOL_CALL_INDEX_MIGRATION = "0031_tool_call_index.sql";
export const PENDING_APPROVALS_VERSION_MIGRATION =
	"0032_pending_approvals_version.sql";
export const SESSIONS_MODEL_SETTINGS_MIGRATION =
	"0033_sessions_model_settings.sql";
export const SESSIONS_SIDE_THREAD_MIGRATION = "0034_sessions_side_thread.sql";
export const SESSIONS_LIMIT_RECOVERY_MIGRATION =
	"0035_sessions_limit_recovery.sql";
export const SESSIONS_RESUMES_MIGRATION = "0036_sessions_resumes.sql";
export const SESSION_SIDEBAR_MIGRATION = "0037_session_sidebar.sql";

export function readMigrationSql(filename: string): string {
	return readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "migrations", filename),
		"utf8",
	);
}
