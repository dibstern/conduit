// Returns full (pre-truncation) tool result content from the SQLite tool_content table.

import { Effect } from "effect";
import { ToolContentServiceTag } from "../domain/relay/Services/tool-content-service.js";

export const getToolContentValue = (toolId: string) =>
	Effect.gen(function* () {
		const toolContent = yield* ToolContentServiceTag;
		return yield* toolContent.get(toolId);
	});
