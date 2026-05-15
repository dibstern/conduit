import type {
	SDKAssistantMessage,
	SDKPartialAssistantMessage,
	SDKTaskProgressMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expectTypeOf, it } from "vitest";

describe("Claude SDK contract", () => {
	it("exposes parent tool linkage fields used by the translator", () => {
		expectTypeOf<SDKPartialAssistantMessage>().toHaveProperty(
			"parent_tool_use_id",
		);
		expectTypeOf<SDKAssistantMessage>().toHaveProperty("parent_tool_use_id");
		expectTypeOf<SDKUserMessage>().toHaveProperty("parent_tool_use_id");
	});

	it("exposes task progress linkage fields used by subagent materialization", () => {
		expectTypeOf<SDKTaskProgressMessage>().toHaveProperty("tool_use_id");
	});
});
