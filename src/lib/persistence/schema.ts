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
export const SESSION_SIDEBAR_TOMBSTONES_MIGRATION =
	"0038_session_sidebar_tombstones.sql";
export const SESSIONS_WORKSPACE_MIGRATION = "0039_sessions_workspace.sql";
export const MESSAGES_INPUT_ID_MIGRATION = "0040_messages_input_id.sql";
export const PENDING_INPUTS_MIGRATION = "0041_pending_inputs.sql";
export const MESSAGES_STEERED_MIGRATION = "0042_messages_steered.sql";
export const SESSIONS_LAST_TURN_END_INPUT_ID_MIGRATION =
	"0043_sessions_last_turn_end_input_id.sql";
export const PROJECT_PROVENANCE_MIGRATION = "0044_project_provenance.sql";
export const MESSAGES_CONTEXT_TOKENS_MIGRATION =
	"0045_messages_context_tokens.sql";
export const MESSAGES_COMPLETED_AT_MIGRATION = "0046_messages_completed_at.sql";
export const SESSIONS_CLAUDE_WORKTREE_STATE_MIGRATION =
	"0047_sessions_claude_worktree_state.sql";
export const SESSIONS_WORKSPACE_HINT_MIGRATION =
	"0048_sessions_workspace_hint.sql";
export const SESSIONS_PENDING_REWIND_MIGRATION =
	"0049_sessions_pending_rewind.sql";
export const MESSAGE_PART_VERSIONS_MIGRATION = "0050_message_part_versions.sql";
export const SESSION_GIT_PUBLISHED_MIGRATION = "0051_session_git_published.sql";
export const STORE_IDENTITY_MIGRATION = "0052_store_identity.sql";
export const EVENTS_UNSTAMPED_INDEX_MIGRATION =
	"0053_events_unstamped_index.sql";
export const EVENTS_SESSION_TYPE_INDEX_MIGRATION =
	"0054_events_session_type_index.sql";
export const DROP_ACTIVITIES_MIGRATION = "0055_drop_activities.sql";
export const SESSION_PICK_BACKFILL_MIGRATION = "0056_session_pick_backfill.sql";
export const COMPACT_REDUNDANT_EVENTS_MIGRATION =
	"0057_compact_redundant_events.sql";
export const SESSION_PROJECT_SCOPE_MIGRATION = "0058_session_project_scope.sql";
export const DAEMON_STORE_IMPORTS_MIGRATION = "0059_daemon_store_imports.sql";
export const SESSIONS_LINEAGE_MIGRATION = "0060_sessions_lineage.sql";
export const LEGACY_FORKS_MIGRATION = "0061_legacy_forks.sql";
export const SESSIONS_ARCHIVED_MIGRATION = "0062_sessions_archived.sql";
export const PROMPT_PROVIDER_REFERENCE_MIGRATION =
	"0063_prompt_provider_reference.sql";
export const TOOL_RESULT_EVENT_REFS_MIGRATION =
	"0064_tool_result_event_refs.sql";
export const PROJECT_TREE_DATA_MIGRATION = "0065_project_tree_data.sql";
export const INPUT_DRAFTS_MIGRATION = "0066_input_drafts.sql";
export const GOAL_CHECK_METADATA_MIGRATION = "0067_goal_check_metadata.sql";
export const MESSAGE_PART_SURFACING_MIGRATION =
	"0068_message_part_surfacing.sql";
export const SESSIONS_SETTLED_SHELF_INDEX_MIGRATION =
	"0069_sessions_settled_shelf_index.sql";
export const SURFACING_MARKS_MIGRATION = "0070_surfacing_marks.sql";
export const MESSAGE_PART_READ_MIGRATION = "0071_message_part_read.sql";
export const TURN_RECAPS_MIGRATION = "0072_turn_recaps.sql";
export const EVENTS_PARENT_ID_INDEX_MIGRATION =
	"0073_events_parent_id_index.sql";
export const EVENTS_FORKED_FROM_INDEX_MIGRATION =
	"0074_events_forked_from_index.sql";
export const MESSAGE_PARTS_RESULT_EVENT_SEQ_INDEX_MIGRATION =
	"0075_message_parts_result_event_seq_index.sql";
export const SESSIONS_GOAL_STUCK_MIGRATION = "0076_sessions_goal_stuck.sql";
export const SESSIONS_JEV_MIGRATION = "0077_sessions_jev.sql";
export const PROVIDER_CONTROL_PROCESS_MIGRATION =
	"0078_provider_control_process.sql";
export const ATTACHMENT_STORE_MIGRATION = "0079_attachment_store.sql";

export const PROJECT_COMMAND_TABLES = [
	"command_receipts",
	"provider_command_sessions",
	"provider_command_turns",
	"provider_command_interactions",
	"provider_command_tombstones",
	"provider_command_outbox",
	"provider_command_meta",
] as const;

export function readMigrationSql(filename: string): string {
	return readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "migrations", filename),
		"utf8",
	);
}
