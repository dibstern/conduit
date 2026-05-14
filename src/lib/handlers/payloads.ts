import type { PermissionId, RequestId } from "../shared-types.js";

// ─── Payload Type Map ────────────────────────────────────────────────────────

/**
 * Type map for all incoming WebSocket message payloads.
 * Each key corresponds to an IncomingMessageType, and the value
 * is the expected shape of the payload for that message type.
 *
 * NOTE: At the dispatch boundary, raw JSON is cast to these types.
 * Phase 2 (Valibot) will add runtime validation.
 */
export interface PayloadMap {
	rewind: { messageId?: string; uuid?: string };
	permission_response: {
		requestId: PermissionId;
		decision: string;
		persistScope?: "tool" | "pattern";
		persistPattern?: string;
	};
	ask_user_response: { toolId: string; answers: Record<string, string> };
	question_reject: { toolId: string };
	new_session: { title?: string; requestId?: RequestId };
	switch_session: { sessionId: string };
	view_session: { sessionId: string };
	delete_session: { sessionId: string };
	fork_session: { sessionId?: string; messageId?: string };
	add_project: { directory: string; instanceId?: string };
	remove_project: { slug: string };
	rename_project: { slug: string; title: string };
	terminal_command: { action: string; ptyId?: string };
	pty_create: Record<string, never>;
	pty_input: { ptyId: string; data: string };
	pty_resize: { ptyId: string; cols?: number; rows?: number };
	pty_close: { ptyId: string };
	instance_add: {
		name: string;
		url?: string;
		managed?: boolean;
		port?: number;
		env?: Record<string, string>;
	};
	instance_remove: { instanceId: string };
	instance_start: { instanceId: string };
	instance_stop: { instanceId: string };
	instance_update: {
		instanceId: string;
		name?: string;
		port?: number;
		env?: Record<string, string>;
	};
	set_project_instance: { slug: string; instanceId: string };
	instance_rename: { instanceId: string; name: string };
	proxy_detect: Record<string, never>;
	scan_now: Record<string, never>;
}
