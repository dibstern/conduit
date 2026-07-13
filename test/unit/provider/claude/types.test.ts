// test/unit/provider/claude/types.test.ts

import type { SDKControlInterruptResponse } from "@anthropic-ai/claude-agent-sdk";
import type { Effect } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	ClaudeResumeCursor,
	ClaudeSessionContext,
	PendingApproval,
	PendingQuestion,
	PromptQueueController,
	Query,
	SDKMessage,
	SDKUserMessage,
	ToolInFlight,
} from "../../../../src/lib/provider/claude/types.js";

describe("Claude provider instance types", () => {
	it("Query extends AsyncGenerator<SDKMessage, void>", () => {
		expectTypeOf<Query>().toMatchTypeOf<AsyncGenerator<SDKMessage, void>>();
		expectTypeOf<Query["interrupt"]>().toEqualTypeOf<
			() => Promise<SDKControlInterruptResponse | undefined>
		>();
		expectTypeOf<Query["setModel"]>().toEqualTypeOf<
			(model?: string) => Promise<void>
		>();
	});

	it("ClaudeResumeCursor shape matches provider_state contract", () => {
		const cursor: ClaudeResumeCursor = {
			resumeSessionId: "abc-123",
			lastAssistantUuid: "def-456",
			turnCount: 3,
		};
		expectTypeOf(cursor).toMatchTypeOf<ClaudeResumeCursor>();
		expect(cursor.turnCount).toBe(3);
	});

	it("PendingApproval carries resolve and reject", () => {
		expectTypeOf<PendingApproval>().toHaveProperty("resolve");
		expectTypeOf<PendingApproval>().toHaveProperty("reject");
		expectTypeOf<PendingApproval>().toHaveProperty("requestId");
		expectTypeOf<PendingApproval>().toHaveProperty("toolName");
		expectTypeOf<PendingApproval>().toHaveProperty("toolInput");
		expectTypeOf<PendingApproval>().toHaveProperty("createdAt");
	});

	it("PendingQuestion carries resolve and reject", () => {
		expectTypeOf<PendingQuestion>().toHaveProperty("resolve");
		expectTypeOf<PendingQuestion>().toHaveProperty("reject");
		expectTypeOf<PendingQuestion>().toHaveProperty("requestId");
		expectTypeOf<PendingQuestion>().toHaveProperty("createdAt");
	});

	it("ClaudeSessionContext owns per-session query state", () => {
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("promptQueue");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("query");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("pendingApprovals");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("pendingQuestions");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("inFlightTools");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("currentTurnId");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("currentModel");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("resumeSessionId");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("lastAssistantUuid");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("turnCount");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("stopped");
	});

	it("ToolInFlight tracks streaming tool_use blocks", () => {
		const tool: ToolInFlight = {
			itemId: "tool-1",
			toolName: "Bash",
			title: "Command run",
			input: { command: "ls" },
			partialInputJson: "",
		};
		expect(tool.toolName).toBe("Bash");
		expect(tool.itemId).toBe("tool-1");
	});

	it("PromptQueueController has enqueue and close", () => {
		expectTypeOf<PromptQueueController>().toHaveProperty("enqueue");
		expectTypeOf<PromptQueueController>().toHaveProperty("close");
		expectTypeOf<PromptQueueController["enqueue"]>().returns.toEqualTypeOf<
			Effect.Effect<void>
		>();
		expectTypeOf<PromptQueueController["close"]>().returns.toEqualTypeOf<
			Effect.Effect<void>
		>();
	});

	it("SDKUserMessage has the expected shape", () => {
		const msg = {
			type: "user" as const,
			message: {
				role: "user" as const,
				content: [{ type: "text", text: "Hello" }],
			},
			parent_tool_use_id: null,
		} as unknown as SDKUserMessage;
		expect(msg.type).toBe("user");
	});
});
