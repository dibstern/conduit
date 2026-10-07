// SQLite projection row types returned by the Effect read services.

import type { HistoryMessage } from "../shared-types.js";

export interface SessionRow {
	id: string;
	version: number;
	provider: string;
	provider_sid: string | null;
	title: string;
	status: string;
	history_complete?: number;
	parent_id: string | null;
	side_thread?: number;
	fork_point_event: string | null;
	fork_point_timestamp?: number | null;
	fork_point_message_id?: string | null;
	last_message_at: number | null;
	last_turn_error_at: number | null;
	permission_mode: string | null;
	model_id?: string | null;
	model_provider?: string | null;
	variant?: string | null;
	context_window?: string | null;
	goal_state?: string | null;
	limit_recovery?: string | null;
	last_turn_end_version?: number | null;
	seen_version?: number | null;
	/** Generated: 1 while a root or fork has a turn end newer than seen. */
	unread?: number;
	settled_at: number | null;
	unsettled_at?: number | null;
	auto_settle_disabled_at?: number | null;
	settled_automatically?: number;
	pinned_at: number | null;
	snoozed_at: number | null;
	snoozed_until: number | null;
	woken_at: number | null;
	woken_reason: "approval" | "question" | "error" | "turn" | null;
	created_at: number;
	updated_at: number;
}

export interface PendingApprovalCountRow {
	session_id: string;
	type: "permission" | "question";
	pending_count: number;
}

/** A pending_approvals row as the approvals subscription reads it (ni8.9). */
export interface PendingApprovalRow {
	id: string;
	session_id: string;
	type: "permission" | "question";
	status: "pending" | "resolved";
	tool_name: string | null;
	/** JSON: the tool input, or a question's questions. */
	input: string | null;
	/** JSON: the rest of the asked payload; NULL on rows from before 0030. */
	details: string | null;
	version: number;
}

export interface PendingClaudeQuestionToolRow {
	id: string;
	call_id: string | null;
	message_id: string;
	input: string | null;
	created_at: number;
	session_id: string;
}

export interface MessageRow {
	id: string;
	version: number;
	session_id: string;
	turn_id: string | null;
	role: string;
	text: string;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	tokens_cache_read: number | null;
	tokens_cache_write: number | null;
	context_window: number | null;
	is_streaming: number;
	is_backfilled: number;
	rest_digest?: string | null;
	rest_event_id?: string | null;
	rest_payload?: string | null;
	parent_id?: string | null;
	finish?: string | null;
	error?: string | null;
	created_at: number;
	updated_at: number;
}

export interface MessagePartRow {
	id: string;
	message_id: string;
	type: string;
	text: string;
	tool_name: string | null;
	call_id: string | null;
	input: string | null;
	result: string | null;
	metadata: string | null;
	duration: number | null;
	status: string | null;
	sort_order: number;
	created_at: number;
	updated_at: number;
	rest_payload?: string | null;
}

export interface MessageWithParts extends MessageRow {
	parts: MessagePartRow[];
	turnTiming?: HistoryMessage["turnTiming"];
	modelExecution?: {
		requestedModel?: string;
		expectedModel?: string;
		actualModel: string;
	};
}

export interface TurnModelExecutionRow {
	requested_model: string | null;
	expected_model: string | null;
	actual_model: string;
}
