// ─── Tool Content Handler ────────────────────────────────────────────────────
// Returns full (pre-truncation) tool result content from the SQLite tool_content table.

import type { PayloadMap } from "./payloads.js";
import { resolveSession } from "./resolve-session.js";
import type { HandlerDeps } from "./types.js";

export async function handleGetToolContent(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["get_tool_content"],
): Promise<void> {
	const { toolId } = payload;
	const sessionId = resolveSession(deps, clientId) ?? "";
	if (typeof toolId !== "string") {
		deps.wsHandler.sendTo(clientId, {
			type: "error",
			sessionId,
			code: "INVALID_PARAMS",
			message: "Missing or invalid toolId parameter",
		});
		return;
	}

	// Read tool content from SQLite via ReadQueryService.
	// Returns NOT_FOUND when readQuery is absent (persistence not configured).
	const content = deps.readQuery?.getToolContent(toolId);
	if (content !== undefined) {
		deps.wsHandler.sendTo(clientId, {
			type: "tool_content",
			sessionId,
			toolId,
			content,
		});
	} else {
		deps.wsHandler.sendTo(clientId, {
			type: "error",
			sessionId,
			code: "NOT_FOUND",
			message: "Full tool content not available",
		});
	}
}
