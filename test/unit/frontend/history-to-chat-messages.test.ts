// ─── historyToChatMessages — Unit Tests ──────────────────────────────────────
// Tests conversion from OpenCode REST API message format (HistoryMessage[])
// to ChatMessage[] used by live message rendering components.
//
// This powers ticket 11.2: History Tool & Thinking Block Rendering.

import { describe, expect, it } from "vitest";
import {
	type HistoryMessage,
	historyToChatMessages,
} from "../../../src/lib/frontend/utils/history-logic.js";
import type { PartType } from "../../../src/lib/shared-types.js";

// ─── Helper factories ────────────────────────────────────────────────────────

function userMsg(id: string, text: string): HistoryMessage {
	return {
		id,
		role: "user",
		parts: [{ id: `${id}-p1`, type: "text", text }],
	};
}

function assistantMsg(
	id: string,
	parts: Array<{ id: string; type: PartType; [key: string]: unknown }>,
	meta?: {
		cost?: number;
		tokens?: { input?: number; output?: number; cache?: { read?: number } };
		time?: { created?: number; completed?: number };
	},
): HistoryMessage {
	return {
		id,
		role: "assistant",
		parts,
		...meta,
	};
}

// ─── User messages ──────────────────────────────────────────────────────────

describe("historyToChatMessages: user messages", () => {
	it("converts a simple user message to UserMessage", () => {
		const messages = [userMsg("m1", "Hello world")];
		const result = historyToChatMessages(messages);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			type: "user",
			text: "Hello world",
		});
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result[0]!.uuid).toBeTruthy();
	});

	it("extracts text from the text-type part", () => {
		const messages: HistoryMessage[] = [
			{
				id: "m1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "What is TypeScript?" }],
			},
		];
		const result = historyToChatMessages(messages);
		expect(result[0]).toMatchObject({
			type: "user",
			text: "What is TypeScript?",
		});
	});

	it("handles user message with no parts gracefully", () => {
		const messages: HistoryMessage[] = [{ id: "m1", role: "user" }];
		const result = historyToChatMessages(messages);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ type: "user", text: "" });
	});
});

// ─── Assistant text messages ────────────────────────────────────────────────

describe("historyToChatMessages: assistant text", () => {
	it("converts a simple text part to AssistantMessage", () => {
		const messages = [
			assistantMsg("m1", [
				{ id: "p1", type: "text", text: "Hello! How can I help?" },
			]),
		];
		const result = historyToChatMessages(messages);

		const assistantMsgs = result.filter((m) => m.type === "assistant");
		expect(assistantMsgs).toHaveLength(1);
		expect(assistantMsgs[0]).toMatchObject({
			type: "assistant",
			rawText: "Hello! How can I help?",
			finalized: true,
		});
	});

	it("converts multiple text parts (split by tool calls) as separate AssistantMessages", () => {
		const messages = [
			assistantMsg("m1", [
				{ id: "p1", type: "text", text: "Let me read that file." },
				{
					id: "p2",
					type: "tool",
					tool: "read",
					callID: "call-1",
					state: { status: "completed", output: "file content" },
				},
				{ id: "p3", type: "text", text: "Here is the content." },
			]),
		];
		const result = historyToChatMessages(messages);

		const assistantMsgs = result.filter((m) => m.type === "assistant");
		expect(assistantMsgs).toHaveLength(2);
		expect(assistantMsgs[0]).toMatchObject({
			rawText: "Let me read that file.",
		});
		expect(assistantMsgs[1]).toMatchObject({ rawText: "Here is the content." });
	});
});

// ─── Thinking blocks ────────────────────────────────────────────────────────

describe("historyToChatMessages: thinking blocks", () => {
	it("converts a reasoning part to ThinkingMessage", () => {
		const messages = [
			assistantMsg("m1", [
				{ id: "p1", type: "reasoning", text: "Let me think about this..." },
				{ id: "p2", type: "text", text: "The answer is 42." },
			]),
		];
		const result = historyToChatMessages(messages);

		const thinkingMsgs = result.filter((m) => m.type === "thinking");
		expect(thinkingMsgs).toHaveLength(1);
		expect(thinkingMsgs[0]).toMatchObject({
			type: "thinking",
			text: "Let me think about this...",
			done: true,
		});
	});

	it("thinking blocks from history are always done (collapsed by default)", () => {
		const messages = [
			assistantMsg("m1", [
				{ id: "p1", type: "reasoning", text: "Thinking..." },
				{ id: "p2", type: "text", text: "Done." },
			]),
		];
		const result = historyToChatMessages(messages);
		const thinking = result.find((m) => m.type === "thinking");
		expect(thinking).toMatchObject({ done: true });
	});

	it("computes thinking duration from time fields when available", () => {
		const messages = [
			assistantMsg("m1", [
				{
					id: "p1",
					type: "reasoning",
					text: "Thinking...",
					time: { start: 1000, end: 3500 },
				},
				{ id: "p2", type: "text", text: "Done." },
			]),
		];
		const result = historyToChatMessages(messages);
		const thinking = result.find((m) => m.type === "thinking");
		expect(thinking).toMatchObject({
			type: "thinking",
			duration: 2500,
		});
	});
});

// ─── Tool calls ─────────────────────────────────────────────────────────────

describe("historyToChatMessages: tool calls", () => {
	it("converts a completed tool part to ToolMessage", () => {
		const messages = [
			assistantMsg("m1", [
				{
					id: "p1",
					type: "tool",
					tool: "Read",
					callID: "call-1",
					state: {
						status: "completed",
						input: { path: "/foo.ts" },
						output: "file contents here",
					},
				},
				{ id: "p2", type: "text", text: "Here is the file." },
			]),
		];
		const result = historyToChatMessages(messages);

		const toolMsgs = result.filter((m) => m.type === "tool");
		expect(toolMsgs).toHaveLength(1);
		expect(toolMsgs[0]).toMatchObject({
			type: "tool",
			id: "call-1",
			name: "Read",
			status: "completed",
			result: "file contents here",
			isError: false,
		});
	});

	it("converts an errored tool part to ToolMessage with error status", () => {
		const messages = [
			assistantMsg("m1", [
				{
					id: "p1",
					type: "tool",
					tool: "Bash",
					callID: "call-2",
					state: {
						status: "error",
						error: "Command failed with exit code 1",
					},
				},
				{ id: "p2", type: "text", text: "The command failed." },
			]),
		];
		const result = historyToChatMessages(messages);

		const toolMsgs = result.filter((m) => m.type === "tool");
		expect(toolMsgs).toHaveLength(1);
		expect(toolMsgs[0]).toMatchObject({
			type: "tool",
			name: "Bash",
			status: "error",
			result: "Command failed with exit code 1",
			isError: true,
		});
	});

	it("uses part ID as fallback when callID is missing", () => {
		const messages = [
			assistantMsg("m1", [
				{
					id: "p1",
					type: "tool",
					tool: "Write",
					state: { status: "completed", output: "ok" },
				},
			]),
		];
		const result = historyToChatMessages(messages);

		const toolMsgs = result.filter((m) => m.type === "tool");
		expect(toolMsgs[0]).toMatchObject({
			id: "p1",
			name: "Write",
		});
	});

	it("extracts tool input from history state", () => {
		const messages = [
			assistantMsg("m1", [
				{
					id: "p1",
					type: "tool",
					tool: "Read",
					callID: "call-1",
					state: {
						status: "completed",
						input: { filePath: "/repo/src/foo.ts", offset: 10 },
						output: "file contents here",
					},
				},
			]),
		];
		const result = historyToChatMessages(messages);

		const toolMsgs = result.filter((m) => m.type === "tool");
		expect(toolMsgs).toHaveLength(1);
		expect(toolMsgs[0]).toMatchObject({
			type: "tool",
			id: "call-1",
			name: "Read",
			input: { filePath: "/repo/src/foo.ts", offset: 10 },
		});
	});

	it("omits tool input when state.input is missing", () => {
		const messages = [
			assistantMsg("m1", [
				{
					id: "p1",
					type: "tool",
					tool: "Read",
					callID: "call-1",
					state: {
						status: "completed",
						output: "file contents",
					},
				},
			]),
		];
		const result = historyToChatMessages(messages);

		const toolMsgs = result.filter((m) => m.type === "tool");
		expect(toolMsgs[0]).not.toHaveProperty("input");
	});

	it("renders multiple tool calls in sequence", () => {
		const messages = [
			assistantMsg("m1", [
				{
					id: "p1",
					type: "tool",
					tool: "Read",
					callID: "c1",
					state: { status: "completed", output: "content A" },
				},
				{
					id: "p2",
					type: "tool",
					tool: "Read",
					callID: "c2",
					state: { status: "completed", output: "content B" },
				},
				{ id: "p3", type: "text", text: "Both files read." },
			]),
		];
		const result = historyToChatMessages(messages);

		const toolMsgs = result.filter((m) => m.type === "tool");
		expect(toolMsgs).toHaveLength(2);
		expect(toolMsgs[0]).toMatchObject({ id: "c1" });
		expect(toolMsgs[1]).toMatchObject({ id: "c2" });
	});
});

// ─── Result bars ────────────────────────────────────────────────────────────

describe("historyToChatMessages: result bars", () => {
	it("generates a ResultMessage from assistant message metadata", () => {
		const messages = [
			assistantMsg("m1", [{ id: "p1", type: "text", text: "Done." }], {
				cost: 0.0042,
				tokens: { input: 1000, output: 200, cache: { read: 500 } },
				time: { created: 1000, completed: 3500 },
			}),
		];
		const result = historyToChatMessages(messages);

		const resultMsgs = result.filter((m) => m.type === "result");
		expect(resultMsgs).toHaveLength(1);
		expect(resultMsgs[0]).toMatchObject({
			type: "result",
			cost: 0.0042,
			inputTokens: 1000,
			outputTokens: 200,
			cacheRead: 500,
			duration: 2500,
		});
	});

	it("does not generate ResultMessage when no cost/token metadata", () => {
		const messages = [
			assistantMsg("m1", [{ id: "p1", type: "text", text: "Hello." }]),
		];
		const result = historyToChatMessages(messages);

		const resultMsgs = result.filter((m) => m.type === "result");
		expect(resultMsgs).toHaveLength(0);
	});
});

// ─── Part ordering ──────────────────────────────────────────────────────────

describe("historyToChatMessages: part ordering", () => {
	it("preserves the order: thinking → text → tool → text → result", () => {
		const messages = [
			userMsg("m1", "Read a file"),
			assistantMsg(
				"m2",
				[
					{ id: "p1", type: "step-start" },
					{ id: "p2", type: "reasoning", text: "Let me think..." },
					{ id: "p3", type: "text", text: "I will read the file." },
					{
						id: "p4",
						type: "tool",
						tool: "Read",
						callID: "c1",
						state: { status: "completed", output: "file content" },
					},
					{ id: "p5", type: "text", text: "Here it is." },
					{ id: "p6", type: "step-finish" },
				],
				{
					cost: 0.01,
					tokens: { input: 500, output: 100 },
					time: { created: 1000, completed: 2000 },
				},
			),
		];
		const result = historyToChatMessages(messages);

		const types = result.map((m) => m.type);
		expect(types).toEqual([
			"user",
			"thinking",
			"assistant",
			"tool",
			"assistant",
			"result",
		]);
	});

	it("skips step-start, step-finish, snapshot, agent parts", () => {
		const messages = [
			assistantMsg("m1", [
				{ id: "p1", type: "step-start" },
				{ id: "p2", type: "text", text: "Hello" },
				{ id: "p3", type: "snapshot" },
				{ id: "p4", type: "agent" },
				{ id: "p5", type: "step-finish" },
			]),
		];
		const result = historyToChatMessages(messages);

		const types = result.map((m) => m.type);
		// Only the text part should produce an AssistantMessage
		expect(types).toEqual(["assistant"]);
	});
});

// ─── Multi-turn conversation ────────────────────────────────────────────────

describe("historyToChatMessages: multi-turn conversation", () => {
	it("converts a full multi-turn conversation", () => {
		const messages: HistoryMessage[] = [
			userMsg("m1", "What is 2+2?"),
			assistantMsg("m2", [{ id: "p1", type: "text", text: "2+2 = 4" }]),
			userMsg("m3", "Read my code"),
			assistantMsg(
				"m4",
				[
					{ id: "p2", type: "reasoning", text: "I need to read the file..." },
					{ id: "p3", type: "text", text: "Let me read it." },
					{
						id: "p4",
						type: "tool",
						tool: "Read",
						callID: "c1",
						state: { status: "completed", output: "code here" },
					},
					{ id: "p5", type: "text", text: "Here is your code." },
				],
				{
					cost: 0.005,
					tokens: { input: 800, output: 150 },
					time: { created: 1000, completed: 3000 },
				},
			),
		];
		const result = historyToChatMessages(messages);

		const types = result.map((m) => m.type);
		expect(types).toEqual([
			"user", // m1
			"assistant", // m2 text
			"user", // m3
			"thinking", // m4 reasoning
			"assistant", // m4 text 1
			"tool", // m4 tool
			"assistant", // m4 text 2
			"result", // m4 metadata
		]);
	});
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("historyToChatMessages: edge cases", () => {
	it("returns empty array for empty input", () => {
		expect(historyToChatMessages([])).toEqual([]);
	});

	it("handles message with empty parts array", () => {
		const messages: HistoryMessage[] = [
			{ id: "m1", role: "assistant", parts: [] },
		];
		const result = historyToChatMessages(messages);
		expect(result).toEqual([]);
	});

	it("handles tool part with pending status", () => {
		const messages = [
			assistantMsg("m1", [
				{
					id: "p1",
					type: "tool",
					tool: "Bash",
					callID: "c1",
					state: { status: "pending" },
				},
			]),
		];
		const result = historyToChatMessages(messages);
		const toolMsgs = result.filter((m) => m.type === "tool");
		expect(toolMsgs[0]).toMatchObject({
			status: "completed",
		});
		// In history, "pending" tools should show as completed since the session is over
	});

	it("generates unique UUIDs for each ChatMessage", () => {
		const messages = [
			userMsg("m1", "Hello"),
			assistantMsg("m2", [{ id: "p1", type: "text", text: "Hi" }]),
		];
		const result = historyToChatMessages(messages);
		const uuids = result.map((m) => m.uuid);
		expect(new Set(uuids).size).toBe(uuids.length);
	});

	it("carries metadata from tool part state to ToolMessage", () => {
		const meta = { sessionId: "ses_child001" };
		const messages = [
			assistantMsg("m1", [
				{
					id: "p1",
					type: "tool" as const,
					tool: "task",
					callID: "call_1",
					state: {
						status: "completed" as const,
						input: { description: "test subagent", subagent_type: "general" },
						output: "task_id: ses_child001\n\n<task_result>done</task_result>",
						metadata: meta,
					},
				},
			]),
		];
		const result = historyToChatMessages(messages);
		const toolMsg = result.find((m) => m.type === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg?.type === "tool") {
			expect(toolMsg.metadata).toEqual(meta);
		}
	});

	it("omits metadata from ToolMessage when not present on part state", () => {
		const messages = [
			assistantMsg("m1", [
				{
					id: "p1",
					type: "tool" as const,
					tool: "read",
					callID: "call_2",
					state: {
						status: "completed" as const,
						output: "file contents",
					},
				},
			]),
		];
		const result = historyToChatMessages(messages);
		const toolMsg = result.find((m) => m.type === "tool");
		expect(toolMsg).toBeDefined();
		if (toolMsg?.type === "tool") {
			expect(toolMsg).not.toHaveProperty("metadata");
		}
	});
});

// ─── applyHistoryQueuedFlag (REMOVED) ───────────────────────────────────────
// Tests removed along with the function — it wrote the old mutable `queued`
// boolean which was replaced by the immutable `sentDuringEpoch` pattern.
// See turn-epoch-queued-pipeline.test.ts for the current queued visual tests.
