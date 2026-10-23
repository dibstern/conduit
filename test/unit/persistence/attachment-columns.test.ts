import { it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { makePersistenceStoreLayer } from "../../../src/lib/persistence/effect/live.js";
import { indexedAttachmentColumns } from "../../helpers/attachment-catalogue.js";

// Explicit classification. These are identifiers, display text, legacy inline
// data, or operational JSON that must never embed an AttachmentRef.
const cannotHoldRefs = {
	attachment_blobs: "hash mime",
	draft_attachments: "id draft_key name hash state",
	attachment_uses: "source_table source_column source_row_key hash",
	command_receipts:
		"command_id session_id status error command_type project_key fingerprint_hash error_code",
	daemon_store_imports:
		"project_id method source_path source_fingerprint rowid_offsets",
	events: "event_id session_id type metadata provider project_id",
	input_drafts: "draft_key project_id kind text promoted_session_id",
	message_part_read_state: "session_id part_id",
	message_part_tombstones: "session_id message_id part_id",
	message_parts:
		"id message_id type text tool_name call_id input result status surfacing_probabilities surfacing_model",
	message_tombstones: "session_id message_id",
	messages:
		"id session_id turn_id role text rest_digest rest_event_id parent_id finish error input_id",
	pending_approvals:
		"id session_id turn_id type status tool_name input decision always details provider_process_id provider_request_id",
	pending_inputs: "input_id session_id text state",
	projection_failures: "projector_name event_type session_id error",
	projector_cursors: "projector_name",
	provider_command_interactions:
		"project_key session_id interaction_id turn_id kind status tombstone_reason",
	provider_command_meta: "project_key",
	provider_command_outbox:
		"command_id project_key session_id provider_id effect_type status error_code run_id provider_process_id",
	provider_command_sessions:
		"project_key session_id provider_id provider_kind provider_session_id status active_turn_id tombstone_reason",
	provider_command_tombstones:
		"project_key scope_kind scope_id session_id turn_id causation_command_id reason_code details_json",
	provider_command_turns:
		"project_key session_id turn_id command_id status user_message_id assistant_message_id error_code tombstone_reason",
	provider_runs: "id session_id status joined_into",
	provider_state: "session_id key value",
	sent_alerts: "session_id alert_key anchor state claim_id",
	session_git_published: "directory git",
	session_goal_checks: "event_id session_id condition reason judge_model",
	session_pick_backfill: "session_id retry_reason",
	session_providers: "id session_id provider provider_sid status",
	session_sidebar: "session_id row project_id",
	sessions:
		"id provider provider_sid title status parent_id fork_point_event permission_mode woken_reason fork_point_message_id goal_state model_id model_provider variant context_window limit_recovery resumes root_id workspace last_turn_end_input_id claude_worktree_state workspace_hint pending_rewind_message_id project_id forked_from goal_stuck jev",
	store_identity: "value",
	surfacing_marks:
		"part_id session_id message_id level category reason direction",
	tool_content: "tool_id session_id content",
	turn_recaps: "turn_id session_id scope text model",
	turns:
		"id session_id state user_message_id assistant_message_id requested_model expected_model actual_model run_id",
};

it.effect(
	"classifies every schema TEXT column before it can persist attachment refs",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const columns = yield* sql<{
				qualified: string;
			}>`SELECT m.name || '.' || p.name AS qualified
		FROM sqlite_master m JOIN pragma_table_info(m.name) p
		WHERE m.type = 'table' AND upper(p.type) = 'TEXT' ORDER BY qualified`;
			const classified = [
				...indexedAttachmentColumns,
				...Object.entries(cannotHoldRefs).flatMap(([table, names]) =>
					names.split(" ").map((name) => `${table}.${name}`),
				),
			];
			expect(columns.map(({ qualified }) => qualified)).toEqual(
				classified.sort(),
			);
		}).pipe(Effect.provide(makePersistenceStoreLayer(":memory:"))),
);
