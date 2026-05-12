// ─── Tool Content Handler ────────────────────────────────────────────────────
// Returns full (pre-truncation) tool result content from the SQLite tool_content table.

import { Effect } from "effect";
import { ReadQueryTag, WebSocketHandlerTag } from "../effect/services.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import type { PayloadMap } from "./payloads.js";

export const handleGetToolContent = (
	clientId: string,
	payload: PayloadMap["get_tool_content"],
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

		// Persistence is optional. Prefer the Effect-native read service when
		// available; keep the legacy sync service as a fallback while Phase 5
		// migrates the larger read surface.
		const readQueryEffectOption =
			yield* Effect.serviceOption(ReadQueryEffectTag);
		const content =
			readQueryEffectOption._tag === "Some"
				? yield* readQueryEffectOption.value.getToolContent(toolId)
				: yield* Effect.gen(function* () {
						const readQueryOption = yield* Effect.serviceOption(ReadQueryTag);
						return readQueryOption._tag === "Some"
							? readQueryOption.value.getToolContent(toolId)
							: undefined;
					});

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
