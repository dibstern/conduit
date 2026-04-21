// ─── Turn Epoch & Queued Pipeline Tests ──────────────────────────────────────
// Integration tests for the multi-step sequences that caused scroll and
// queued-message bugs.  These test the PIPELINE (multiple functions in
// sequence), not individual functions in isolation.
//
// The queued visual is DERIVED: sentDuringEpoch != null && turnEpoch <= sentDuringEpoch.
// No mutable flags or clearing needed — turnEpoch advancing is the only signal.
//
// Bugs these tests prevent:
// 1. sentDuringEpoch set incorrectly (wrong epoch or missing)
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
	restoreCachedMessages,
	type SessionActivity,
	type SessionMessages,
	stashSessionMessages,
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
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

// ─── Reset ──────────────────────────────────────────────────────────────────

// ─── Per-session tiers for handler calls ────────────────────────────────────
let ta: SessionActivity;
let tm: SessionMessages;

beforeEach(() => {
	sessionState.currentId = "test-session";
	// Register sessions so routePerSession's unknown-session guard passes.
	sessionState.sessions.set("test-session", { id: "test-session", title: "" });
	sessionState.sessions.set("s1", { id: "s1", title: "" });
	clearMessages();
	ta = testActivity();
	tm = testMessages();
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

/** Mirrors the derived visual logic in UserMessage.svelte. */
function isVisuallyQueued(msg: UserMessage): boolean {
	return (
		msg.sentDuringEpoch != null && chatState.turnEpoch <= msg.sentDuringEpoch
	);
}

// ─── turnEpoch basics ───────────────────────────────────────────────────────

describe("turnEpoch tracking", () => {
	it("starts at 0", () => {
		expect(chatState.turnEpoch).toBe(0);
	});

	it("increments on handleDone", () => {
		handleDelta(ta, tm, { type: "delta", sessionId: "s1", text: "hello" });
		expect(chatState.turnEpoch).toBe(0);

		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });
		expect(chatState.turnEpoch).toBe(1);
	});

	it("increments for each turn", () => {
		// Turn 1
		handleDelta(ta, tm, { type: "delta", sessionId: "s1", text: "a" });
		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });
		expect(chatState.turnEpoch).toBe(1);

		// Turn 2
		handleDelta(ta, tm, { type: "delta", sessionId: "s1", text: "b" });
		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });
		expect(chatState.turnEpoch).toBe(2);
	});

	it("resets to 0 on clearMessages", () => {
		handleDelta(ta, tm, { type: "delta", sessionId: "s1", text: "a" });
		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });
		expect(chatState.turnEpoch).toBe(1);

		clearMessages();
		ta = testActivity();
		tm = testMessages();
		expect(chatState.turnEpoch).toBe(0);
	});

	it("tracks turns during replay", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "q1" },
			{ type: "delta", sessionId: "s1", text: "a1" },
			{ type: "done", sessionId: "s1", code: 0 },
			{ type: "user_message", sessionId: "s1", text: "q2" },
			{ type: "delta", sessionId: "s1", text: "a2" },
			{ type: "done", sessionId: "s1", code: 0 },
		];

		replayEvents(events, "test-session");
		await vi.runAllTimersAsync();

		expect(chatState.turnEpoch).toBe(2);
	});
});

// ─── Queued shimmer persists until new turn ─────────────────────────────────

describe("queued shimmer persists through current-turn deltas", () => {
	it("sentDuringEpoch survives continuation deltas (visual stays queued)", () => {
		// Start an assistant turn
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "Working on ",
		} as RelayMessage);
		expect(isStreaming()).toBe(true);

		// User queues a message mid-stream
		addUserMessage(ta, tm, "follow-up question", undefined, true);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(true);

		// More deltas arrive from the CURRENT turn — visual stays queued
		// because turnEpoch hasn't advanced past sentDuringEpoch
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "your request...",
		} as RelayMessage);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(true);

		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: " almost done",
		} as RelayMessage);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(true);
	});

	it("visual queued clears when done advances turnEpoch", () => {
		// Turn 1: assistant streaming
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "response",
		} as RelayMessage);

		// User queues message at epoch 0
		addUserMessage(ta, tm, "next question", undefined, true);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(true);

		// Turn 1 completes — done increments turnEpoch to 1
		// sentDuringEpoch was 0, so turnEpoch(1) > sentDuringEpoch(0) → not queued
		handleMessage({ type: "done", sessionId: "s1", code: 0 } as RelayMessage);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(false);

		// sentDuringEpoch is still set (write-once, never mutated)
		expect(userMessages()[0]?.sentDuringEpoch).toBe(0);
	});

	it("visual queued clears when new assistant message starts (done path)", () => {
		// Turn 1: assistant streaming
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "response 1",
		} as RelayMessage);

		// User queues message at epoch 0
		addUserMessage(ta, tm, "follow-up", undefined, true);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(true);

		// done fires — bumps turnEpoch, sets phase to idle
		handleMessage({ type: "done", sessionId: "s1", code: 0 } as RelayMessage);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(false);

		// Response 2 starts (normal done→idle→delta path, no messageId)
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "response 2",
		} as RelayMessage);

		// Shimmer stays cleared — done already bumped turnEpoch
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(false);
		expect(assistantMessages()).toHaveLength(2);
	});

	it("visual queued clears when new assistant starts even without done or messageId", () => {
		// Turn 1: assistant streaming (no messageId on deltas)
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "response 1",
		} as RelayMessage);

		// User queues message at epoch 0
		addUserMessage(ta, tm, "follow-up", undefined, true);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(true);

		// done fires (this is the normal path — done IS reliable in most cases)
		handleMessage({ type: "done", sessionId: "s1", code: 0 } as RelayMessage);

		// Next response starts — no messageId. The done already cleared
		// the shimmer, so this is a verification that it STAYS cleared.
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "response 2",
		} as RelayMessage);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(false);
	});

	it("visual queued clears when new-turn detection fires (no done between responses)", () => {
		// Turn 1: assistant streaming with messageId
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "response 1",
			messageId: "msg-1",
		} as RelayMessage);
		expect(isStreaming()).toBe(true);

		// User queues message at epoch 0
		addUserMessage(ta, tm, "follow-up", undefined, true);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(true);
		expect(chatState.turnEpoch).toBe(0);

		// More deltas from same messageId — shimmer stays
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: " more text",
			messageId: "msg-1",
		} as RelayMessage);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(true);

		// New delta with DIFFERENT messageId (response 2) — no done between.
		// New-turn detection fires: finalize response 1, bump turnEpoch,
		// create new assistant message.
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "response 2",
			messageId: "msg-2",
		} as RelayMessage);

		// turnEpoch should have advanced past sentDuringEpoch → shimmer clears
		expect(chatState.turnEpoch).toBe(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(false);

		// Messages should be properly separated
		expect(assistantMessages()).toHaveLength(2);
	});
});

// ─── Queued message doesn't split assistant ─────────────────────────────────

describe("queued user message doesn't split assistant response", () => {
	it("assistant continues as one message when user queues mid-stream", () => {
		// Start streaming
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "Part 1 ",
		} as RelayMessage);
		expect(assistantMessages()).toHaveLength(1);

		// User queues a message
		addUserMessage(ta, tm, "queued msg", undefined, true);

		// More deltas from same turn
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "Part 2",
		} as RelayMessage);

		// Should still be ONE assistant message, not two
		expect(assistantMessages()).toHaveLength(1);
		// Message order: assistant, user
		expect(msgTypes()).toEqual(["assistant", "user"]);
	});

	it("new turn creates a separate assistant message after queued user msg", () => {
		// Turn 1
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "Turn 1 response",
		} as RelayMessage);
		addUserMessage(ta, tm, "queued", undefined, true);
		handleMessage({ type: "done", sessionId: "s1", code: 0 } as RelayMessage);

		// Turn 2
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "Turn 2 response",
		} as RelayMessage);
		handleMessage({ type: "done", sessionId: "s1", code: 0 } as RelayMessage);

		// Should be: assistant(turn1), user, assistant(turn2)
		expect(msgTypes()).toEqual(["assistant", "user", "assistant"]);
		expect(assistantMessages()).toHaveLength(2);
	});
});

// ─── Replay pipeline: queued flags with turnEpoch ───────────────────────────

describe("replay pipeline: sentDuringEpoch respects turn boundaries", () => {
	it("sentDuringEpoch is set during replay; visual clears after done", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "first" },
			{ type: "delta", sessionId: "s1", text: "responding..." },
			// User sent second message while LLM was active
			{ type: "user_message", sessionId: "s1", text: "second" },
			{ type: "delta", sessionId: "s1", text: " still going" },
			{ type: "done", sessionId: "s1", code: 0 },
			// New turn starts — turnEpoch advanced past sentDuringEpoch
			{ type: "delta", sessionId: "s1", text: "Answering second..." },
			{ type: "done", sessionId: "s1", code: 0 },
		];

		replayEvents(events, "test-session");
		await vi.runAllTimersAsync();

		const users = userMessages();
		expect(users).toHaveLength(2);
		// First was not queued (no prior LLM activity)
		expect(users[0]?.sentDuringEpoch).toBeUndefined();
		// Second was queued at epoch 0, but turnEpoch is now 2 → not visually queued
		expect(users[1]?.sentDuringEpoch).toBe(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(users[1]!)).toBe(false);
		expect(chatState.turnEpoch).toBe(2);
	});

	it("sentDuringEpoch persists visually when replay ends mid-stream", async () => {
		// Session still processing — no done event at end
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "first" },
			{ type: "delta", sessionId: "s1", text: "working on first..." },
			{ type: "user_message", sessionId: "s1", text: "second (queued)" },
			{ type: "delta", sessionId: "s1", text: " still going" },
			// No done — session is mid-stream
		];

		replayEvents(events, "test-session");
		await vi.runAllTimersAsync();

		const users = userMessages();
		expect(users).toHaveLength(2);
		// Second message has sentDuringEpoch = 0, turnEpoch = 0 → still visually queued
		expect(users[1]?.sentDuringEpoch).toBe(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(users[1]!)).toBe(true);
		expect(chatState.turnEpoch).toBe(0);
	});
});

// ─── clearMessages resets all turn tracking ─────────────────────────────────

describe("clearMessages resets turn tracking cleanly", () => {
	it("resets turnEpoch and queued tracking on session switch", () => {
		// Build up some state
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "hello",
		} as RelayMessage);
		addUserMessage(ta, tm, "queued", undefined, true);
		handleMessage({ type: "done", sessionId: "s1", code: 0 } as RelayMessage);
		expect(chatState.turnEpoch).toBe(1);

		// Session switch clears everything
		clearMessages();
		ta = testActivity();
		tm = testMessages();
		expect(chatState.turnEpoch).toBe(0);
		expect(chatState.messages).toHaveLength(0);
		expect(isStreaming()).toBe(false);
	});

	it("sentDuringEpoch doesn't leak across sessions", () => {
		// Session A: queue a message
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "A response",
		} as RelayMessage);
		addUserMessage(ta, tm, "queued in A", undefined, true);

		// Switch to session B
		clearMessages();
		ta = testActivity();
		tm = testMessages();

		// Session B: fresh turnEpoch — no stale state from session A
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "B response",
		} as RelayMessage);
		expect(isStreaming()).toBe(true);
		expect(userMessages()).toHaveLength(0);
	});
});

// ─── Session message cache preserves turnEpoch ──────────────────────────────

describe("session cache round-trip preserves turnEpoch", () => {
	it("restored messages with sentDuringEpoch are not visually queued after cache round-trip", () => {
		// Turn 1: queue a message at epoch 0
		handleMessage({
			type: "delta",
			sessionId: "s1",
			text: "response",
		} as RelayMessage);
		addUserMessage(ta, tm, "queued msg", undefined, true);
		expect(userMessages()[0]?.sentDuringEpoch).toBe(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(true);

		// Turn 1 completes — shimmer clears
		handleMessage({ type: "done", sessionId: "s1", code: 0 } as RelayMessage);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(false);
		expect(chatState.turnEpoch).toBe(1);

		// Stash and switch away
		stashSessionMessages("sess-A");
		clearMessages();
		ta = testActivity();
		tm = testMessages();
		expect(chatState.turnEpoch).toBe(0);

		// Restore — turnEpoch must be restored so sentDuringEpoch comparison is correct
		const hit = restoreCachedMessages("sess-A");
		expect(hit).toBe(true);
		expect(chatState.turnEpoch).toBe(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[0]!)).toBe(false);
	});
});
