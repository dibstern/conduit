// test/unit/provider/claude/types.test.ts
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	ClaudeResumeCursor,
	ClaudeSessionContext,
	PendingApproval,
	PendingQuestion,
	PromptQueueController,
	PromptQueueItem,
	Query,
	SDKMessage,
	SDKUserMessage,
	ToolInFlight,
} from "../../../../src/lib/provider/claude/types.js";

describe("Claude adapter types", () => {
	it("Query extends AsyncGenerator<SDKMessage, void>", () => {
		expectTypeOf<Query>().toMatchTypeOf<AsyncGenerator<SDKMessage, void>>();
		expectTypeOf<Query["interrupt"]>().toEqualTypeOf<() => Promise<void>>();
		expectTypeOf<Query["setModel"]>().toEqualTypeOf<
			(model?: string) => Promise<void>
		>();
	});

	it("PromptQueueItem is a discriminated union", () => {
		const msg: PromptQueueItem = {
			type: "message",
			message: {
				type: "user",
				parent_tool_use_id: null,
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			} as unknown as SDKUserMessage,
		};
		const term: PromptQueueItem = { type: "terminate" };
		expectTypeOf(msg).toMatchTypeOf<PromptQueueItem>();
		expectTypeOf(term).toMatchTypeOf<PromptQueueItem>();
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

	it("ClaudeSessionContext owns the prompt queue and query runtime", () => {
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("promptQueue");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("query");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("pendingApprovals");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("pendingQuestions");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("inFlightTools");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("streamConsumer");
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
