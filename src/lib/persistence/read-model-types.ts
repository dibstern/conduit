// Shared SQLite projection row types used by legacy and Effect read services.

export interface SessionRow {
	id: string;
	provider: string;
	provider_sid: string | null;
	title: string;
	status: string;
	parent_id: string | null;
	fork_point_event: string | null;
	last_message_at: number | null;
	created_at: number;
	updated_at: number;
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
	duration: number | null;
	status: string | null;
	sort_order: number;
	created_at: number;
	updated_at: number;
}

export interface MessageWithParts extends MessageRow {
	parts: MessagePartRow[];
}

export interface TurnRow {
	id: string;
	session_id: string;
	state: string;
	user_message_id: string | null;
	assistant_message_id: string | null;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	requested_at: number;
	started_at: number | null;
	completed_at: number | null;
}

export interface PendingApprovalRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	type: string;
	status: string;
	tool_name: string | null;
	input: string | null;
	decision: string | null;
	created_at: number;
	resolved_at: number | null;
}

export interface ForkMetadata {
	parentId: string;
	forkPointEvent: string | null;
}
