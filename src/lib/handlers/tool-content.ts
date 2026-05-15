// ─── Tool Content Handler ────────────────────────────────────────────────────
// Returns full (pre-truncation) tool result content from the SQLite tool_content table.

import { Effect } from "effect";
import { WebSocketHandlerTag } from "../domain/relay/Services/services.js";
import { ToolContentServiceTag } from "../domain/relay/Services/tool-content-service.js";

export const getToolContentValue = (toolId: string) =>
	Effect.gen(function* () {
		const toolContent = yield* ToolContentServiceTag;
		return yield* toolContent.get(toolId);
	});

export const handleGetToolContent = (
	clientId: string,
	payload: { toolId: string },
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;

		const { toolId } = payload;
		const sessionId = wsHandler.getClientSession(clientId) ?? "";

		if (typeof toolId !== "string") {
			wsHandler.sendTo(clientId, {
				type: "error",
				sessionId,
				code: "INVALID_PARAMS",
				message: "Missing or invalid toolId parameter",
			});
			return;
		}

		const content = yield* getToolContentValue(toolId);

		if (content !== undefined) {
			wsHandler.sendTo(clientId, {
				type: "tool_content",
				sessionId,
				toolId,
				content,
			});
		} else {
			wsHandler.sendTo(clientId, {
				type: "error",
				sessionId,
				code: "NOT_FOUND",
				message: "Full tool content not available",
			});
		}
	});
