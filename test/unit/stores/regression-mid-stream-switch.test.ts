// ─── Regression: Mid-Stream Session Switch ───────────────────────────────────
// Reproduces: "when we switch away from a session that has received messages
// from opencode, then switch back to it, the history of messages received
// from opencode are gone"
//
// Scenario: User is viewing session A, agent sends partial response (deltas),
// user switches to session B, agent continues working on session A in the
// background (events cached by relay), user switches back to session A.
// All messages should be visible as if the user never left.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock localStorage BEFORE any store modules are loaded.
vi.hoisted(() => {
	let store: Record<string, string> = {};
	const mock = {
		getItem: vi.fn((key: string) => store[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
		get length() {
			return Object.keys(store).length;
		},
		key: vi.fn((_: number) => null),
	};
	Object.defineProperty(globalThis, "localStorage", {
		value: mock,
		writable: true,
		configurable: true,
	});
});

// Mock DOMPurify (browser-only) before importing stores
vi.mock("dompurify", () => ({
	default: {
		sanitize: (html: string) => html,
	},
}));

import {
	addUserMessage,
	chatState,
	clearMessages,
	handleDelta,
	handleDone,
	isProcessing,
	isStreaming,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";
import type {
	AssistantMessage,
	ThinkingMessage,
	ToolMessage,
} from "../../../src/lib/frontend/types.js";

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	sessionState.rootSessions = [];
	sessionState.allSessions = [];
	sessionState.searchResults = null;
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	sessionState.hasMore = false;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Core regression: mid-stream switch back restores messages ───────────────

describe("Regression: mid-stream session switch preserves messages", () => {
	it("switching away mid-stream then back with cached events restores full conversation", async () => {
		// ── Phase 1: Live streaming on session A ──
		sessionState.currentId = "session-a";
		addUserMessage("What is TypeScript?");
		handleDelta({ type: "delta", text: "TypeScript is " });
		vi.advanceTimersByTime(100);
		handleDelta({ type: "delta", text: "a typed superset " });
		vi.advanceTimersByTime(100);

		// Verify we have live messages
		expect(chatState.messages.length).toBeGreaterThan(0);
		const liveUserMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(liveUserMsgs).toHaveLength(1);
		expect(isStreaming()).toBe(true);

		// ── Phase 2: Switch to session B (clears everything) ──
		handleMessage({ type: "session_switched", id: "session-b" });
		expect(chatState.messages).toHaveLength(0);
		expect(isStreaming()).toBe(false);
		expect(sessionState.currentId).toBe("session-b");

		// ── Phase 3: Switch back to session A with full cached events ──
		// The relay would have cached ALL events for session A, including
		// events that arrived while viewing session B.
		handleMessage({
			type: "session_switched",
			id: "session-a",
			events: [
				{ type: "user_message", text: "What is TypeScript?" },
				// Note: "status" events are NOT persisted (excluded from
				// PERSISTED_EVENT_TYPES in event-pipeline.ts), so they never
				// appear in real persisted event arrays.
				{ type: "delta", text: "TypeScript is " },
				{ type: "delta", text: "a typed superset " },
				// These arrived while viewing session B:
				{ type: "delta", text: "of JavaScript that " },
				{ type: "delta", text: "compiles to plain JS." },
				{ type: "done", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		// ── Verify: ALL messages should be present ──
		expect(sessionState.currentId).toBe("session-a");

		// User message
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("What is TypeScript?");

		// Assistant message with ALL deltas combined
		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(1);
		expect((assistantMsgs[0] as AssistantMessage).rawText).toBe(
			"TypeScript is a typed superset of JavaScript that compiles to plain JS.",
		);
		expect((assistantMsgs[0] as AssistantMessage).finalized).toBe(true);

		// Stream should be complete
		expect(isStreaming()).toBe(false);
		expect(isProcessing()).toBe(false);
	});

	it("switching away mid-stream then back WITHOUT done preserves partial stream", async () => {
		// Session A active, partial response
		sessionState.currentId = "session-a";

		// Switch to B
		handleMessage({ type: "session_switched", id: "session-b" });

		// Switch back to A — agent is STILL working (no done event)
		handleMessage({
			type: "session_switched",
			id: "session-a",
			events: [
				{ type: "user_message", text: "Explain monads" },
				{ type: "delta", text: "A monad is " },
				{ type: "delta", text: "a design pattern " },
				// Agent is still working — no done event
			],
		});
		await vi.runAllTimersAsync();

		// User message should be present
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);

		// Partial assistant message should be present
		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(1);
		expect((assistantMsgs[0] as AssistantMessage).rawText).toBe(
			"A monad is a design pattern ",
		);
		expect((assistantMsgs[0] as AssistantMessage).finalized).toBe(false);

		// Should still be streaming (agent still working)
		expect(isStreaming()).toBe(true);
		expect(isProcessing()).toBe(true);
	});

	it("switching away during tool execution then back preserves tool state", async () => {
		sessionState.currentId = "session-a";

		// Switch to B, then back to A with tool events
		handleMessage({ type: "session_switched", id: "session-b" });
		handleMessage({
			type: "session_switched",
			id: "session-a",
			events: [
				{ type: "user_message", text: "Read foo.ts" },
				{ type: "delta", text: "Let me read that file." },
				{ type: "tool_start", id: "t1", name: "Read" },
				{
					type: "tool_executing",
					id: "t1",
					name: "Read",
					input: { path: "foo.ts" },
				},
				{
					type: "tool_result",
					id: "t1",
					content: "export const x = 42;",
					is_error: false,
				},
				{ type: "delta", text: "The file contains a constant." },
				{ type: "done", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		// User message
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);

		// Assistant messages: text before and after tool should be separate blocks
		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(2);
		// First block: text before the tool call
		expect((assistantMsgs[0] as AssistantMessage).rawText).toBe(
			"Let me read that file.",
		);
		expect((assistantMsgs[0] as AssistantMessage).finalized).toBe(true);
		// Second block: text after the tool call
		expect((assistantMsgs[1] as AssistantMessage).rawText).toBe(
			"The file contains a constant.",
		);
		expect((assistantMsgs[1] as AssistantMessage).finalized).toBe(true);

		// Tool message
		const toolMsgs = chatState.messages.filter((m) => m.type === "tool");
		expect(toolMsgs).toHaveLength(1);
		expect((toolMsgs[0] as ToolMessage).name).toBe("Read");
		expect((toolMsgs[0] as ToolMessage).status).toBe("completed");
	});

	it("switching away during thinking then back preserves thinking block", async () => {
		sessionState.currentId = "session-a";

		handleMessage({ type: "session_switched", id: "session-b" });
		handleMessage({
			type: "session_switched",
			id: "session-a",
			events: [
				{ type: "user_message", text: "Complex question" },
				{ type: "thinking_start" },
				{ type: "thinking_delta", text: "Let me think about this..." },
				{ type: "thinking_stop" },
				{ type: "delta", text: "Here is my answer." },
				{ type: "done", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		// Thinking message
		const thinkingMsgs = chatState.messages.filter(
			(m) => m.type === "thinking",
		);
		expect(thinkingMsgs).toHaveLength(1);
		expect((thinkingMsgs[0] as ThinkingMessage).text).toBe(
			"Let me think about this...",
		);
		expect((thinkingMsgs[0] as ThinkingMessage).done).toBe(true);

		// Assistant message
		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(1);
		expect((assistantMsgs[0] as AssistantMessage).rawText).toBe(
			"Here is my answer.",
		);
	});

	it("multi-turn conversation: switch away then back preserves all turns", async () => {
		sessionState.currentId = "session-a";

		handleMessage({ type: "session_switched", id: "session-b" });
		handleMessage({
			type: "session_switched",
			id: "session-a",
			events: [
				// Turn 1
				{ type: "user_message", text: "Hello" },
				{ type: "delta", text: "Hi there!" },
				{ type: "done", code: 0 },
				// Turn 2
				{ type: "user_message", text: "How are you?" },
				{ type: "delta", text: "I'm doing well, thanks!" },
				{ type: "done", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		// Should have 2 user messages and 2 assistant messages
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(2);
		expect((userMsgs[0] as { text: string }).text).toBe("Hello");
		expect((userMsgs[1] as { text: string }).text).toBe("How are you?");

		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(2);
		expect((assistantMsgs[0] as AssistantMessage).rawText).toBe("Hi there!");
		expect((assistantMsgs[0] as AssistantMessage).finalized).toBe(true);
		expect((assistantMsgs[1] as AssistantMessage).rawText).toBe(
			"I'm doing well, thanks!",
		);
		expect((assistantMsgs[1] as AssistantMessage).finalized).toBe(true);
	});

	it("rapid switch: A→B→A with events — only final A's events are displayed", async () => {
		sessionState.currentId = "session-a";
		addUserMessage("message in A");
		handleDelta({ type: "delta", text: "response in A" });
		vi.advanceTimersByTime(100);

		// Rapid switch A→B→A
		handleMessage({ type: "session_switched", id: "session-b" });
		expect(chatState.messages).toHaveLength(0);

		handleMessage({
			type: "session_switched",
			id: "session-a",
			events: [
				{ type: "user_message", text: "message in A" },
				{ type: "delta", text: "response in A" },
				{ type: "delta", text: " (continued)" },
				{ type: "done", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		// Should show the replayed events, not the stale live messages
		expect(sessionState.currentId).toBe("session-a");
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("message in A");

		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(1);
		expect((assistantMsgs[0] as AssistantMessage).rawText).toBe(
			"response in A (continued)",
		);
	});

	it("switch back to session with NO cached events shows nothing (REST fallback needed)", () => {
		sessionState.currentId = "session-a";
		addUserMessage("message");
		handleDelta({ type: "delta", text: "response" });
		vi.advanceTimersByTime(100);
		handleDone({ type: "done", code: 0 });

		// Switch to B and back to A WITHOUT events (cache miss — relay would
		// normally use REST fallback, but here we test the bare switch)
		handleMessage({ type: "session_switched", id: "session-b" });
		handleMessage({ type: "session_switched", id: "session-a" });

		// Without events or history, messages should be empty
		// (REST fallback would populate HistoryView, not chat messages)
		expect(chatState.messages).toHaveLength(0);
		expect(sessionState.currentId).toBe("session-a");
	});

	it("events from session A continue arriving live after switching back mid-stream", async () => {
		// Switch to session A with mid-stream events (no done)
		handleMessage({
			type: "session_switched",
			id: "session-a",
			events: [
				{ type: "user_message", text: "Hello" },
				{ type: "delta", text: "Working on " },
			],
		});
		await vi.runAllTimersAsync();

		// Should be mid-stream
		expect(isStreaming()).toBe(true);
		expect(isProcessing()).toBe(true);

		// Now simulate live events continuing to arrive (agent still working)
		handleMessage({ type: "delta", text: "your request..." });
		vi.advanceTimersByTime(100);

		// The live delta should append to the existing assistant message
		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(1);
		expect((assistantMsgs[0] as AssistantMessage).rawText).toBe(
			"Working on your request...",
		);

		// Complete the stream
		handleMessage({ type: "done", code: 0 });
		expect(isStreaming()).toBe(false);
		expect(isProcessing()).toBe(false);
		expect((assistantMsgs[0] as AssistantMessage).finalized).toBe(false); // stale ref
		// Re-read from state
		const finalAssistant = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect((finalAssistant[0] as AssistantMessage).finalized).toBe(true);
	});
});
