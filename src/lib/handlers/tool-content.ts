// ─── Tool Content Handler ────────────────────────────────────────────────────
// Returns full (pre-truncation) tool result content stored in ToolContentStore.

import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

export async function handleGetToolContent(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["get_tool_content"],
): Promise<void> {
	const { toolId } = payload;
	if (typeof toolId !== "string") {
		deps.wsHandler.sendTo(clientId, {
			type: "error",
			code: "INVALID_PARAMS",
			message: "Missing or invalid toolId parameter",
		});
		return;
	}

	const content = deps.toolContentStore.get(toolId);
	if (content !== undefined) {
		deps.wsHandler.sendTo(clientId, {
			type: "tool_content",
			toolId,
			content,
		});
	} else {
		deps.wsHandler.sendTo(clientId, {
			type: "error",
			code: "NOT_FOUND",
			message: "Full tool content not available",
		});
	}
}
