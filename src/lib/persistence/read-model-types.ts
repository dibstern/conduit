// SQLite projection row types returned by the Effect read services.

export interface SessionRow {
	id: string;
	provider: string;
	provider_sid: string | null;
	title: string;
	status: string;
	parent_id: string | null;
	fork_point_event: string | null;
	last_message_at: number | null;
	last_turn_error_at: number | null;
	permission_mode: string | null;
	read_at: number | null;
	settled_at: number | null;
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

export interface MessageRow {
	id: string;
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
}

export interface MessageWithParts extends MessageRow {
	parts: MessagePartRow[];
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
