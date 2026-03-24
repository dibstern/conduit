// ─── Tool Message Factory ────────────────────────────────────────────────────
// Single factory for constructing ToolMessage objects.
// Used by both history-logic.ts (REST history) and tool-registry.ts (SSE lifecycle).
// Eliminates duplicated construction logic across the two call sites.

import type { ToolStatus } from "../../shared-types.js";
import type { ToolMessage } from "../types.js";

/** Initialization data for creating a ToolMessage. */
export interface ToolMessageInit {
	uuid: string;
	id: string;
	name: string;
	status: ToolStatus;
	result?: string;
	isError?: boolean;
	input?: unknown;
	metadata?: Record<string, unknown>;
	messageId?: string;
	isTruncated?: boolean;
	fullContentLength?: number;
}

/**
 * Create a ToolMessage from initialization data.
 *
 * Optional fields are only included when their values are defined,
 * keeping the object shape clean (no `undefined` property values).
 */
export function createToolMessage(init: ToolMessageInit): ToolMessage {
	return {
		type: "tool",
		uuid: init.uuid,
		id: init.id,
		name: init.name,
		status: init.status,
		...(init.result !== undefined && { result: init.result }),
		...(init.isError !== undefined && { isError: init.isError }),
		...(init.input !== undefined && { input: init.input }),
		...(init.metadata !== undefined && { metadata: init.metadata }),
		...(init.messageId !== undefined && { messageId: init.messageId }),
		...(init.isTruncated !== undefined && { isTruncated: init.isTruncated }),
		...(init.fullContentLength !== undefined && {
			fullContentLength: init.fullContentLength,
		}),
	};
}
