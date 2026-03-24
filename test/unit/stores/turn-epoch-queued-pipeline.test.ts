// ─── Turn Epoch & Queued-Flag Pipeline Tests ────────────────────────────────
// Integration tests for the multi-step sequences that caused scroll and
// queued-message bugs.  These test the PIPELINE (multiple functions in
// sequence), not individual functions in isolation.
//
// Bugs these tests prevent:
// 1. Queued shimmer stripped by continuation deltas from the current turn
// 2. Assistant message split when queued user message finalizes the stream
// 3. turnEpoch correctly tracks turn boundaries across live and replay paths

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
	isStreaming,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	handleMessage,
	replayEvents,
} from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type {
	AssistantMessage,
	UserMessage,
} from "../../../src/lib/frontend/types.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── Reset ──────────────────────────────────────────────────────────────────

beforeEach(() => {
	sessionState.currentId = "test-session";
	clearMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function userMessages(): UserMessage[] {
	return chatState.messages.filter((m): m is UserMessage => m.type === "user");
}

function assistantMessages(): AssistantMessage[] {
	return chatState.messages.filter(
		(m): m is AssistantMessage => m.type === "assistant",
	);
}

function msgTypes(): string[] {
	return chatState.messages.map((m) => m.type);
}

// ─── turnEpoch basics ───────────────────────────────────────────────────────

describe("turnEpoch tracking", () => {
	it("starts at 0", () => {
		expect(chatState.turnEpoch).toBe(0);
	});

	it("increments on handleDone", () => {
		handleDelta({ type: "delta", text: "hello" });
		expect(chatState.turnEpoch).toBe(0);

		handleDone({ type: "done", code: 0 });
		expect(chatState.turnEpoch).toBe(1);
	});

	it("increments for each turn", () => {
		// Turn 1
		handleDelta({ type: "delta", text: "a" });
		handleDone({ type: "done", code: 0 });
		expect(chatState.turnEpoch).toBe(1);

		// Turn 2
		handleDelta({ type: "delta", text: "b" });
		handleDone({ type: "done", code: 0 });
		expect(chatState.turnEpoch).toBe(2);
	});

	it("resets to 0 on clearMessages", () => {
		handleDelta({ type: "delta", text: "a" });
		handleDone({ type: "done", code: 0 });
		expect(chatState.turnEpoch).toBe(1);

		clearMessages();
		expect(chatState.turnEpoch).toBe(0);
	});

	it("tracks turns during replay", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "q1" },
			{ type: "delta", text: "a1" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "q2" },
			{ type: "delta", text: "a2" },
			{ type: "done", code: 0 },
		];

		replayEvents(events);
		await vi.runAllTimersAsync();

		expect(chatState.turnEpoch).toBe(2);
	});
});

// ─── Queued shimmer persists until new turn ─────────────────────────────────

describe("queued shimmer persists through current-turn deltas", () => {
	it("queued flag survives continuation deltas from current turn", () => {
		// Start an assistant turn
		handleMessage({ type: "delta", text: "Working on " } as RelayMessage);
		expect(isStreaming()).toBe(true);

		// User queues a message mid-stream
		addUserMessage("follow-up question", undefined, true);
		expect(userMessages()[0]?.queued).toBe(true);

		// More deltas arrive from the CURRENT turn — must NOT clear queued
		handleMessage({ type: "delta", text: "your request..." } as RelayMessage);
		expect(userMessages()[0]?.queued).toBe(true);

		handleMessage({ type: "delta", text: " almost done" } as RelayMessage);
		expect(userMessages()[0]?.queued).toBe(true);
	});

	it("queued flag is cleared when the NEW turn starts", () => {
		// Turn 1: assistant streaming
		handleMessage({ type: "delta", text: "response" } as RelayMessage);

		// User queues message
		addUserMessage("next question", undefined, true);
		expect(userMessages()[0]?.queued).toBe(true);

		// Turn 1 completes
		handleMessage({ type: "done", code: 0 } as RelayMessage);
		// Still queued — done doesn't clear, content start of new turn does
		expect(userMessages()[0]?.queued).toBe(true);

		// Turn 2 starts — THIS should clear the queued flag
		handleMessage({ type: "delta", text: "new response" } as RelayMessage);
		expect(userMessages()[0]?.queued).toBe(false);
	});
});

// ─── Queued message doesn't split assistant ─────────────────────────────────

describe("queued user message doesn't split assistant response", () => {
	it("assistant continues as one message when user queues mid-stream", () => {
		// Start streaming
		handleMessage({ type: "delta", text: "Part 1 " } as RelayMessage);
		expect(assistantMessages()).toHaveLength(1);

		// User queues a message
		addUserMessage("queued msg", undefined, true);

		// More deltas from same turn
		handleMessage({ type: "delta", text: "Part 2" } as RelayMessage);

		// Should still be ONE assistant message, not two
		expect(assistantMessages()).toHaveLength(1);
		// Message order: assistant, user
		expect(msgTypes()).toEqual(["assistant", "user"]);
	});

	it("new turn creates a separate assistant message after queued user msg", () => {
		// Turn 1
		handleMessage({ type: "delta", text: "Turn 1 response" } as RelayMessage);
		addUserMessage("queued", undefined, true);
		handleMessage({ type: "done", code: 0 } as RelayMessage);

		// Turn 2
		handleMessage({ type: "delta", text: "Turn 2 response" } as RelayMessage);
		handleMessage({ type: "done", code: 0 } as RelayMessage);

		// Should be: assistant(turn1), user, assistant(turn2)
		expect(msgTypes()).toEqual(["assistant", "user", "assistant"]);
		expect(assistantMessages()).toHaveLength(2);
	});
});

// ─── Replay pipeline: queued flags with turnEpoch ───────────────────────────

describe("replay pipeline: queued flags respect turn boundaries", () => {
	it("queued flag set during replay is cleared by next-turn content", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "first" },
			{ type: "delta", text: "responding..." },
			// User sent second message while LLM was active
			{ type: "user_message", text: "second" },
			{ type: "delta", text: " still going" },
			{ type: "done", code: 0 },
			// New turn starts — should clear queued on "second"
			{ type: "delta", text: "Answering second..." },
			{ type: "done", code: 0 },
		];

		replayEvents(events);
		await vi.runAllTimersAsync();

		const users = userMessages();
		expect(users).toHaveLength(2);
		// Both should be non-queued after full replay
		expect(users[0]?.queued).toBeFalsy();
		expect(users[1]?.queued).toBeFalsy();
		// Turn epoch should be 2 (two done events)
		expect(chatState.turnEpoch).toBe(2);
	});

	it("queued flag persists when replay ends mid-stream", async () => {
		// Session still processing — no done event at end
		const events: RelayMessage[] = [
			{ type: "user_message", text: "first" },
			{ type: "delta", text: "working on first..." },
			{ type: "user_message", text: "second (queued)" },
			{ type: "delta", text: " still going" },
			// No done — session is mid-stream
		];

		replayEvents(events);
		await vi.runAllTimersAsync();

		const users = userMessages();
		expect(users).toHaveLength(2);
		// Second message should still be queued (no done → no new turn)
		expect(users[1]?.queued).toBe(true);
		expect(chatState.turnEpoch).toBe(0); // no done events
	});
});

// ─── clearMessages resets all turn tracking ─────────────────────────────────

describe("clearMessages resets turn tracking cleanly", () => {
	it("resets turnEpoch and queued tracking on session switch", () => {
		// Build up some state
		handleMessage({ type: "delta", text: "hello" } as RelayMessage);
		addUserMessage("queued", undefined, true);
		handleMessage({ type: "done", code: 0 } as RelayMessage);
		expect(chatState.turnEpoch).toBe(1);

		// Session switch clears everything
		clearMessages();
		expect(chatState.turnEpoch).toBe(0);
		expect(chatState.messages).toHaveLength(0);
		expect(isStreaming()).toBe(false);
	});

	it("queued tracking doesn't leak across sessions", () => {
		// Session A: queue a message
		handleMessage({ type: "delta", text: "A response" } as RelayMessage);
		addUserMessage("queued in A", undefined, true);

		// Switch to session B
		clearMessages();

		// Session B: first delta should be able to clear queued flags normally
		// (no stale queuedAtEpoch from session A)
		handleMessage({ type: "delta", text: "B response" } as RelayMessage);
		// No queued messages exist, so this is just a normal delta
		expect(isStreaming()).toBe(true);
		expect(userMessages()).toHaveLength(0);
	});
});
