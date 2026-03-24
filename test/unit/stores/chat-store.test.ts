// ─── Chat Store Tests ────────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock DOMPurify (browser-only) before importing the store
vi.mock("dompurify", () => ({
	default: {
		sanitize: (html: string) => html,
	},
}));

import {
	addSystemMessage,
	addUserMessage,
	chatState,
	clearMessages,
	clearQueuedFlags,
	handleDelta,
	handleDone,
	handleError,
	handleResult,
	handleThinkingDelta,
	handleThinkingStart,
	handleThinkingStop,
	handleToolExecuting,
	handleToolResult,
	handleToolStart,
	historyState,
	isProcessing,
	isStreaming,
	phaseToProcessing,
	phaseToStreaming,
	prependMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import type {
	AssistantMessage,
	RelayMessage,
	ResultMessage,
	ThinkingMessage,
	ToolMessage,
	UserMessage as UserMsg,
} from "../../../src/lib/frontend/types.js";

// ─── Helper: cast incomplete test data to the expected type ─────────────────
// Tests deliberately pass incomplete objects to verify defensive handling.
function msg<T extends RelayMessage["type"]>(data: {
	type: T;
	[k: string]: unknown;
}): Extract<RelayMessage, { type: T }> {
	return data as Extract<RelayMessage, { type: T }>;
}

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	sessionState.currentId = "test-session";
	clearMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── handleDelta (streaming text) ───────────────────────────────────────────

describe("handleDelta", () => {
	it("creates an assistant message on first delta", () => {
		handleDelta({ type: "delta", text: "Hello" });
		expect(chatState.messages).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(chatState.messages[0]!.type).toBe("assistant");
		expect(isStreaming()).toBe(true);
	});

	it("accumulates text in currentAssistantText", () => {
		handleDelta({ type: "delta", text: "Hello " });
		handleDelta({ type: "delta", text: "world" });
		expect(chatState.currentAssistantText).toBe("Hello world");
	});

	it("does not create duplicate assistant messages on subsequent deltas", () => {
		handleDelta({ type: "delta", text: "a" });
		handleDelta({ type: "delta", text: "b" });
		const assistantMessages = chatState.messages.filter(
			(m: { type: string }) => m.type === "assistant",
		);
		expect(assistantMessages).toHaveLength(1);
	});

	// Non-string text is now a compile-time error (typed as `string`).
	// Runtime validation happens at the WS dispatch layer, not in store handlers.

	it("updates assistant message HTML after debounce", () => {
		handleDelta({ type: "delta", text: "**bold**" });
		vi.advanceTimersByTime(100);
		const m = chatState.messages[0] as AssistantMessage;
		expect(m.rawText).toBe("**bold**");
		// HTML should contain <strong> from markdown rendering
		expect(m.html).toContain("<strong>");
	});
});

// ─── handleThinkingStart / handleThinkingDelta / handleThinkingStop ─────────

describe("thinking lifecycle", () => {
	it("creates a thinking message on start", () => {
		handleThinkingStart({ type: "thinking_start" });
		expect(chatState.messages).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(chatState.messages[0]!.type).toBe("thinking");
		expect((chatState.messages[0] as ThinkingMessage).done).toBe(false);
	});

	it("appends text on thinking delta", () => {
		handleThinkingStart({ type: "thinking_start" });
		handleThinkingDelta({ type: "thinking_delta", text: "pondering " });
		handleThinkingDelta({ type: "thinking_delta", text: "deeply" });
		const m = chatState.messages[0] as ThinkingMessage;
		expect(m.text).toBe("pondering deeply");
	});

	it("marks thinking as done on stop with duration", () => {
		vi.setSystemTime(new Date(1000));
		handleThinkingStart({ type: "thinking_start" });
		vi.setSystemTime(new Date(3500));
		handleThinkingStop({ type: "thinking_stop" });
		const m = chatState.messages[0] as ThinkingMessage;
		expect(m.done).toBe(true);
		expect(m.duration).toBe(2500);
	});

	// Non-string text is now a compile-time error (typed as `string`).
	// Runtime validation happens at the WS dispatch layer, not in store handlers.
});

// ─── handleToolStart / handleToolExecuting / handleToolResult ───────────────

describe("tool lifecycle", () => {
	it("creates a tool message on start", () => {
		handleToolStart({ type: "tool_start", id: "t1", name: "Read" });
		expect(chatState.messages).toHaveLength(1);
		const m = chatState.messages[0] as ToolMessage;
		expect(m.type).toBe("tool");
		expect(m.name).toBe("Read");
		expect(m.status).toBe("pending");
	});

	it("transitions to running on executing", () => {
		handleToolStart({ type: "tool_start", id: "t1", name: "Read" });
		handleToolExecuting(msg({ type: "tool_executing", id: "t1" }));
		const m = chatState.messages[0] as ToolMessage;
		expect(m.status).toBe("running");
	});

	it("transitions to completed on result", () => {
		handleToolStart({ type: "tool_start", id: "t1", name: "Read" });
		handleToolResult({
			type: "tool_result",
			id: "t1",
			content: "file contents",
			is_error: false,
		});
		const m = chatState.messages[0] as ToolMessage;
		expect(m.status).toBe("completed");
		expect(m.result).toBe("file contents");
	});

	it("transitions to error on result with is_error", () => {
		handleToolStart({ type: "tool_start", id: "t1", name: "Write" });
		handleToolResult({
			type: "tool_result",
			id: "t1",
			content: "permission denied",
			is_error: true,
		});
		const m = chatState.messages[0] as ToolMessage;
		expect(m.status).toBe("error");
		expect(m.isError).toBe(true);
	});

	it("uses 'unknown' for missing tool name", () => {
		handleToolStart(msg({ type: "tool_start", id: "t1" }));
		const m = chatState.messages[0] as ToolMessage;
		expect(m.name).toBe("unknown");
	});

	it("handleToolExecuting stores input on tool message", () => {
		handleToolStart({ type: "tool_start", id: "t1", name: "Read" });
		handleToolExecuting({
			type: "tool_executing",
			id: "t1",
			name: "Read",
			input: { filePath: "/repo/src/foo.ts", offset: 10 },
		});

		const tool = chatState.messages.find(
			(m) => m.type === "tool" && m.id === "t1",
		) as ToolMessage | undefined;
		expect(tool).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(tool!.status).toBe("running");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(tool!.input).toEqual({ filePath: "/repo/src/foo.ts", offset: 10 });
	});

	it("silently ignores executing for unknown tool id (expected overlap)", () => {
		handleToolExecuting(msg({ type: "tool_executing", id: "unknown" }));
		expect(chatState.messages).toHaveLength(0);
	});

	it("propagates isTruncated and fullContentLength from tool_result", () => {
		handleToolStart({ type: "tool_start", id: "t1", name: "Read" });
		handleToolResult({
			type: "tool_result",
			id: "t1",
			content: "truncated content...",
			is_error: false,
			isTruncated: true,
			fullContentLength: 128000,
		});
		const m = chatState.messages[0] as ToolMessage;
		expect(m.isTruncated).toBe(true);
		expect(m.fullContentLength).toBe(128000);
	});

	it("leaves isTruncated undefined when not present in tool_result", () => {
		handleToolStart({ type: "tool_start", id: "t1", name: "Read" });
		handleToolResult({
			type: "tool_result",
			id: "t1",
			content: "small content",
			is_error: false,
		});
		const m = chatState.messages[0] as ToolMessage;
		expect(m.isTruncated).toBeUndefined();
		expect(m.fullContentLength).toBeUndefined();
	});

	it("finalizes streaming assistant message before adding tool message", () => {
		// Simulate: delta text → tool_start → more delta text
		handleDelta({ type: "delta", text: "Before tool" });
		vi.advanceTimersByTime(100); // flush render
		expect(chatState.messages).toHaveLength(1);
		expect(isStreaming()).toBe(true);

		handleToolStart({ type: "tool_start", id: "t1", name: "Read" });

		// The first assistant message should now be finalized
		const firstAssistant = chatState.messages[0] as AssistantMessage;
		expect(firstAssistant.type).toBe("assistant");
		expect(firstAssistant.finalized).toBe(true);
		expect(firstAssistant.rawText).toBe("Before tool");

		// streaming should be reset so next delta creates a new message
		expect(isStreaming()).toBe(false);
		expect(chatState.currentAssistantText).toBe("");
	});

	it("creates separate assistant messages for text before and after tool calls", () => {
		// Text before tool
		handleDelta({ type: "delta", text: "Part 1" });
		vi.advanceTimersByTime(100);

		// Tool lifecycle
		handleToolStart({ type: "tool_start", id: "t1", name: "Read" });
		handleToolResult({
			type: "tool_result",
			id: "t1",
			content: "file contents",
			is_error: false,
		});

		// Text after tool
		handleDelta({ type: "delta", text: "Part 2" });
		vi.advanceTimersByTime(100);

		const assistantMessages = chatState.messages.filter(
			(m: { type: string }) => m.type === "assistant",
		);
		expect(assistantMessages).toHaveLength(2);
		expect((assistantMessages[0] as AssistantMessage).rawText).toBe("Part 1");
		expect((assistantMessages[1] as AssistantMessage).rawText).toBe("Part 2");
	});

	it("does not finalize when no text was accumulated before tool_start", () => {
		// Tool starts immediately with no preceding text
		handleToolStart({ type: "tool_start", id: "t1", name: "Read" });
		expect(chatState.messages).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(chatState.messages[0]!.type).toBe("tool");
		// No assistant message should have been created
		const assistantMessages = chatState.messages.filter(
			(m: { type: string }) => m.type === "assistant",
		);
		expect(assistantMessages).toHaveLength(0);
	});

	it("deduplicates tool_start with same callID (prevents duplicate question cards)", () => {
		// First tool_start creates the ToolMessage
		handleToolStart({
			type: "tool_start",
			id: "toolu_abc",
			name: "AskUserQuestion",
		});
		expect(chatState.messages).toHaveLength(1);

		// Second tool_start for the same callID (e.g., from message poller) is ignored
		handleToolStart({
			type: "tool_start",
			id: "toolu_abc",
			name: "AskUserQuestion",
		});
		expect(chatState.messages).toHaveLength(1);
	});

	it("after handleDone, duplicate tool_start is ignored and tool stays completed", () => {
		handleToolStart({
			type: "tool_start",
			id: "toolu_abc",
			name: "AskUserQuestion",
		});
		expect(chatState.messages).toHaveLength(1);

		// handleDone force-finalizes the pending tool to completed
		handleDone({ type: "done", code: 0 });
		const afterDone = chatState.messages[0] as ToolMessage;
		expect(afterDone.status).toBe("completed");

		// Second tool_start for the same ID is a duplicate — ignored by registry
		handleToolStart({
			type: "tool_start",
			id: "toolu_abc",
			name: "AskUserQuestion",
		});
		expect(chatState.messages).toHaveLength(1);

		// Executing is silently rejected — tool already completed (expected overlap)
		handleToolExecuting({
			type: "tool_executing",
			id: "toolu_abc",
			name: "AskUserQuestion",
			input: { question: "Approve?" },
		});
		const tool = chatState.messages[0] as ToolMessage;
		// Tool stays completed — registry blocks completed -> running
		expect(tool.status).toBe("completed");
	});
});

// ─── handleResult ───────────────────────────────────────────────────────────

describe("handleResult", () => {
	it("adds a result message with cost and token info from usage object", () => {
		handleResult({
			type: "result",
			cost: 0.05,
			duration: 1200,
			usage: { input: 100, output: 200, cache_read: 50, cache_creation: 10 },
			sessionId: "s1",
		});
		expect(chatState.messages).toHaveLength(1);
		const m = chatState.messages[0] as ResultMessage;
		expect(m.type).toBe("result");
		expect(m.cost).toBe(0.05);
		expect(m.duration).toBe(1200);
		expect(m.inputTokens).toBe(100);
		expect(m.outputTokens).toBe(200);
		expect(m.cacheRead).toBe(50);
		expect(m.cacheWrite).toBe(10);
	});

	it("handles missing usage object gracefully", () => {
		handleResult(
			msg({
				type: "result",
				cost: 0.01,
				duration: 500,
			}),
		);
		const m = chatState.messages[0] as ResultMessage;
		expect(m.cost).toBe(0.01);
		expect(m.inputTokens).toBeUndefined();
		expect(m.outputTokens).toBeUndefined();
	});

	it("updates existing result bar in-place instead of creating duplicate", () => {
		// First result: cost + tokens but no duration (mid-stream update)
		handleResult({
			type: "result",
			cost: 0.05,
			duration: 0,
			usage: { input: 100, output: 200, cache_read: 50, cache_creation: 10 },
			sessionId: "s1",
		});
		expect(chatState.messages).toHaveLength(1);

		// Second result: same data but with duration added (completion update)
		handleResult({
			type: "result",
			cost: 0.05,
			duration: 1200,
			usage: { input: 100, output: 200, cache_read: 50, cache_creation: 10 },
			sessionId: "s1",
		});
		// Should still be just 1 result message, updated in-place
		expect(chatState.messages).toHaveLength(1);
		const m = chatState.messages[0] as ResultMessage;
		expect(m.cost).toBe(0.05);
		expect(m.duration).toBe(1200);
		expect(m.inputTokens).toBe(100);
	});

	it("creates new result bar after non-result message separates them", () => {
		// First turn result
		handleResult({
			type: "result",
			cost: 0.05,
			duration: 1200,
			usage: { input: 100, output: 200, cache_read: 0, cache_creation: 0 },
			sessionId: "s1",
		});
		// User message separates turns
		addUserMessage("next question");
		// Second turn result
		handleResult({
			type: "result",
			cost: 0.1,
			duration: 2400,
			usage: { input: 200, output: 400, cache_read: 0, cache_creation: 0 },
			sessionId: "s1",
		});
		const results = chatState.messages.filter(
			(m: { type: string }) => m.type === "result",
		);
		expect(results).toHaveLength(2);
	});
});

// ─── handleDone ─────────────────────────────────────────────────────────────

describe("handleDone", () => {
	it("clears streaming state", () => {
		handleDelta({ type: "delta", text: "hi" });
		expect(isStreaming()).toBe(true);

		handleDone({ type: "done", code: 0 });
		expect(isStreaming()).toBe(false);
		expect(isProcessing()).toBe(false);
		expect(chatState.currentAssistantText).toBe("");
	});

	it("finalizes the assistant message", () => {
		handleDelta({ type: "delta", text: "final text" });
		handleDone({ type: "done", code: 0 });
		const m = chatState.messages[0] as AssistantMessage;
		expect(m.finalized).toBe(true);
	});
});

// ─── handleError ────────────────────────────────────────────────────────────

describe("handleError", () => {
	it("adds an info system message for RETRY code", () => {
		handleError({ type: "error", code: "RETRY", message: "Retrying..." });
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const m = chatState.messages[0]!;
		expect(m.type).toBe("system");
		if (m.type === "system") {
			expect(m.variant).toBe("info");
			expect(m.text).toBe("Retrying...");
		}
	});

	it("adds an error system message for non-RETRY", () => {
		handleError({ type: "error", code: "UNKNOWN", message: "Something broke" });
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const m = chatState.messages[0]!;
		expect(m.type).toBe("system");
		if (m.type === "system") {
			expect(m.variant).toBe("error");
		}
	});

	it("stops processing on non-RETRY error", () => {
		phaseToStreaming();
		handleError({ type: "error", code: "FATAL", message: "fail" });
		expect(isProcessing()).toBe(false);
		expect(isStreaming()).toBe(false);
	});

	it("does NOT stop processing on RETRY", () => {
		phaseToProcessing();
		handleError({ type: "error", code: "RETRY", message: "retry" });
		expect(isProcessing()).toBe(true);
	});

	it("uses fallback text when message is empty", () => {
		handleError({ type: "error", code: "", message: "" });
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const m = chatState.messages[0]!;
		if (m.type === "system") {
			// Empty message is still passed through; the store uses msg.message directly
			expect(m.text).toBe("");
		}
	});
});

// ─── addUserMessage / addSystemMessage ──────────────────────────────────────

describe("addUserMessage", () => {
	it("adds a user message", () => {
		addUserMessage("hello");
		expect(chatState.messages).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(chatState.messages[0]!.type).toBe("user");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		if (chatState.messages[0]!.type === "user") {
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(chatState.messages[0]!.text).toBe("hello");
		}
	});

	it("includes images when provided", () => {
		addUserMessage("look", ["img1.png"]);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		if (chatState.messages[0]!.type === "user") {
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(chatState.messages[0]!.images).toEqual(["img1.png"]);
		}
	});

	it("finalizes streaming assistant message when called mid-stream", () => {
		// Simulate an assistant streaming (deltas without done)
		handleDelta(msg({ type: "delta", text: "Shall I proceed?" }));
		vi.advanceTimersByTime(100);

		expect(isStreaming()).toBe(true);
		expect(chatState.currentAssistantText).toBe("Shall I proceed?");

		// Now a user message arrives (e.g. during event replay without
		// an intervening done event, or user replied mid-stream)
		addUserMessage("Yes");

		// The streaming state should be reset
		expect(isStreaming()).toBe(false);
		expect(chatState.currentAssistantText).toBe("");

		// The assistant message should be finalized
		const assistantMsgs = chatState.messages.filter(
			(m): m is AssistantMessage => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(1);
		expect(assistantMsgs[0]?.finalized).toBe(true);
		expect(assistantMsgs[0]?.rawText).toBe("Shall I proceed?");

		// The user message should be separate and after the assistant message
		const userMsgs = chatState.messages.filter(
			(m): m is UserMsg => m.type === "user",
		);
		expect(userMsgs).toHaveLength(1);
		expect(userMsgs[0]?.text).toBe("Yes");

		// Subsequent deltas should create a NEW assistant message
		handleDelta(msg({ type: "delta", text: "New response" }));
		vi.advanceTimersByTime(100);

		const allAssistant = chatState.messages.filter(
			(m): m is AssistantMessage => m.type === "assistant",
		);
		expect(allAssistant).toHaveLength(2);
		expect(allAssistant[1]?.rawText).toBe("New response");
		expect(allAssistant[1]?.finalized).toBe(false);
	});
});

describe("addSystemMessage", () => {
	it("adds an info system message by default", () => {
		addSystemMessage("info text");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const m = chatState.messages[0]!;
		if (m.type === "system") {
			expect(m.variant).toBe("info");
		}
	});

	it("adds an error system message when variant specified", () => {
		addSystemMessage("error text", "error");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const m = chatState.messages[0]!;
		if (m.type === "system") {
			expect(m.variant).toBe("error");
		}
	});
});

// ─── clearMessages ──────────────────────────────────────────────────────────

describe("clearMessages", () => {
	it("clears all messages and resets state", () => {
		addUserMessage("hi");
		handleDelta({ type: "delta", text: "response" });
		clearMessages();
		expect(chatState.messages).toHaveLength(0);
		expect(chatState.currentAssistantText).toBe("");
		expect(isStreaming()).toBe(false);
		expect(isProcessing()).toBe(false);
	});
});

// ─── Queued User Messages ──────────────────────────────────────────────────

describe("queued user message flag", () => {
	it("addUserMessage sets queued flag when passed", () => {
		addUserMessage("hello", undefined, true);
		expect(chatState.messages).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const msg = chatState.messages[0]!;
		expect(msg.type).toBe("user");
		expect((msg as UserMsg).queued).toBe(true);
	});

	it("addUserMessage defaults queued to undefined", () => {
		addUserMessage("hello");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const msg = chatState.messages[0]!;
		expect((msg as UserMsg).queued).toBeUndefined();
	});

	it("clearQueuedFlags clears queued flag on all user messages", () => {
		addUserMessage("first", undefined, true);
		addUserMessage("second", undefined, true);
		addUserMessage("third");
		clearQueuedFlags();
		for (const m of chatState.messages) {
			if (m.type === "user") {
				expect((m as UserMsg).queued).toBeFalsy();
			}
		}
	});

	it("clearQueuedFlags is a no-op when no queued messages", () => {
		addUserMessage("normal");
		const before = chatState.messages;
		clearQueuedFlags();
		// Should not create new array reference if nothing changed
		expect(chatState.messages).toBe(before);
	});

	it("clearMessages resets all state", () => {
		addUserMessage("test", undefined, true);
		clearMessages();
		expect(chatState.messages).toHaveLength(0);
		expect(isProcessing()).toBe(false);
		expect(isStreaming()).toBe(false);
	});
});

// ─── Duplicate message deduplication ────────────────────────────────────────

describe("duplicate message deduplication", () => {
	it("suppresses duplicate deltas after done for same messageId", () => {
		// First turn: deltas with messageId → done
		handleDelta({ type: "delta", text: "Hello", messageId: "msg_A" });
		vi.advanceTimersByTime(100);
		handleDone({ type: "done", code: 0 });

		expect(chatState.messages).toHaveLength(1);
		const firstMsg = chatState.messages[0] as AssistantMessage;
		expect(firstMsg.rawText).toBe("Hello");
		expect(firstMsg.finalized).toBe(true);

		// Second turn: duplicate deltas with same messageId (from stale poller)
		handleDelta({ type: "delta", text: "Hello", messageId: "msg_A" });
		vi.advanceTimersByTime(100);

		// Should still be just 1 message — the duplicate was silently dropped
		expect(chatState.messages).toHaveLength(1);
		expect(isStreaming()).toBe(false);
	});

	it("does NOT suppress deltas after tool_start finalization (tool-split)", () => {
		// First chunk: deltas with messageId
		handleDelta({ type: "delta", text: "Before tool", messageId: "msg_A" });
		vi.advanceTimersByTime(100);
		expect(chatState.messages).toHaveLength(1);

		// tool_start finalizes the assistant message but does NOT add to doneMessageIds
		handleToolStart({ type: "tool_start", id: "t1", name: "Read" });

		const firstAssistant = chatState.messages[0] as AssistantMessage;
		expect(firstAssistant.finalized).toBe(true);

		// Second chunk: more deltas with same messageId after tool
		handleDelta({ type: "delta", text: "After tool", messageId: "msg_A" });
		vi.advanceTimersByTime(100);

		// Should create a new AssistantMessage (tool_start doesn't add to doneMessageIds)
		const assistantMessages = chatState.messages.filter(
			(m: { type: string }) => m.type === "assistant",
		);
		expect(assistantMessages).toHaveLength(2);
		expect((assistantMessages[1] as AssistantMessage).rawText).toBe(
			"After tool",
		);
	});

	it("does not suppress deltas with a different messageId", () => {
		// First turn: msg_A → done
		handleDelta({ type: "delta", text: "First", messageId: "msg_A" });
		vi.advanceTimersByTime(100);
		handleDone({ type: "done", code: 0 });

		expect(chatState.messages).toHaveLength(1);

		// Second turn: msg_B (different ID) should NOT be suppressed
		handleDelta({ type: "delta", text: "Second", messageId: "msg_B" });
		vi.advanceTimersByTime(100);

		const assistantMessages = chatState.messages.filter(
			(m: { type: string }) => m.type === "assistant",
		);
		expect(assistantMessages).toHaveLength(2);
		expect((assistantMessages[1] as AssistantMessage).rawText).toBe("Second");
	});

	it("never suppresses deltas without a messageId", () => {
		// First turn: no messageId → done
		handleDelta({ type: "delta", text: "First" });
		vi.advanceTimersByTime(100);
		handleDone({ type: "done", code: 0 });

		expect(chatState.messages).toHaveLength(1);

		// Second turn: also no messageId → should NOT be suppressed
		handleDelta({ type: "delta", text: "Second" });
		vi.advanceTimersByTime(100);

		const assistantMessages = chatState.messages.filter(
			(m: { type: string }) => m.type === "assistant",
		);
		expect(assistantMessages).toHaveLength(2);
		expect((assistantMessages[1] as AssistantMessage).rawText).toBe("Second");
	});

	it("clearMessages resets dedup state so same messageId works again", () => {
		// First turn: msg_A → done (adds to doneMessageIds)
		handleDelta({ type: "delta", text: "Original", messageId: "msg_A" });
		vi.advanceTimersByTime(100);
		handleDone({ type: "done", code: 0 });

		expect(chatState.messages).toHaveLength(1);

		// clearMessages should clear doneMessageIds
		clearMessages();
		expect(chatState.messages).toHaveLength(0);

		// Same messageId should now work again
		handleDelta({ type: "delta", text: "Replayed", messageId: "msg_A" });
		vi.advanceTimersByTime(100);

		expect(chatState.messages).toHaveLength(1);
		const m = chatState.messages[0] as AssistantMessage;
		expect(m.rawText).toBe("Replayed");
	});

	it("handles duplicate result bars properly after delta dedup", () => {
		// First turn: deltas + result + done
		handleDelta({ type: "delta", text: "Answer", messageId: "msg_A" });
		vi.advanceTimersByTime(100);
		handleResult({
			type: "result",
			cost: 0.05,
			duration: 1200,
			usage: { input: 100, output: 200, cache_read: 0, cache_creation: 0 },
			sessionId: "s1",
		});
		handleDone({ type: "done", code: 0 });

		// Should have: [assistant, result]
		expect(chatState.messages).toHaveLength(2);
		expect(chatState.messages[0]?.type).toBe("assistant");
		expect(chatState.messages[1]?.type).toBe("result");

		// Duplicate deltas with same messageId are suppressed
		handleDelta({ type: "delta", text: "Answer", messageId: "msg_A" });
		vi.advanceTimersByTime(100);

		// Still [assistant, result] — no new assistant message
		expect(chatState.messages).toHaveLength(2);

		// Duplicate result merges into the existing one (last message is ResultMessage)
		handleResult({
			type: "result",
			cost: 0.06,
			duration: 1300,
			usage: { input: 110, output: 210, cache_read: 5, cache_creation: 1 },
			sessionId: "s1",
		});

		// Still 2 messages — the result was updated in-place
		expect(chatState.messages).toHaveLength(2);
		const result = chatState.messages[1] as ResultMessage;
		expect(result.cost).toBe(0.06);
		expect(result.duration).toBe(1300);
	});
});

// ─── prependMessages ────────────────────────────────────────────────────────

describe("prependMessages", () => {
	beforeEach(() => {
		clearMessages();
	});

	it("prepends messages before existing messages", () => {
		addUserMessage("live message");
		const older = [
			{ type: "user" as const, uuid: "h1", text: "older message" },
		];
		prependMessages(older);
		expect(chatState.messages).toHaveLength(2);
		expect((chatState.messages[0] as UserMsg).text).toBe("older message");
		expect((chatState.messages[1] as UserMsg).text).toBe("live message");
	});

	it("prepends into empty array", () => {
		prependMessages([
			{ type: "user" as const, uuid: "h1", text: "from history" },
		]);
		expect(chatState.messages).toHaveLength(1);
		expect((chatState.messages[0] as UserMsg).text).toBe("from history");
	});

	it("no-ops on empty input", () => {
		addUserMessage("existing");
		prependMessages([]);
		expect(chatState.messages).toHaveLength(1);
	});
});

// ─── historyState ───────────────────────────────────────────────────────────

describe("historyState", () => {
	beforeEach(() => {
		clearMessages();
	});

	it("defaults hasMore to false and loading to false after clearMessages", () => {
		expect(historyState.hasMore).toBe(false);
		expect(historyState.loading).toBe(false);
		expect(historyState.messageCount).toBe(0);
	});

	it("clearMessages resets historyState", () => {
		historyState.hasMore = true;
		historyState.loading = true;
		historyState.messageCount = 42;
		clearMessages();
		expect(historyState.hasMore).toBe(false);
		expect(historyState.loading).toBe(false);
		expect(historyState.messageCount).toBe(0);
	});
});
