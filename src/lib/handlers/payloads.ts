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
	pty_input: { ptyId: string; data: string };
}
