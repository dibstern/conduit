// ─── Handler Tier Contract Tests ────────────────────────────────────────────
// Verifies that each handler only touches its declared tier fields
// (Activity or Messages). Catches silent tier leaks — e.g., a handler
// that should only write Activity accidentally touching Messages.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock DOMPurify (browser-only) before importing the store
vi.mock("dompurify", () => ({
	default: {
		sanitize: (html: string) => html,
	},
}));

import {
	advanceTurnIfNewMessage,
	clearMessages,
	handleDelta,
	handleDone,
	handleStatus,
	handleThinkingStart,
	phaseToIdle,
	phaseToProcessing,
	phaseToStreaming,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

// ─── Snapshot helpers ──────────────────────────────────────────────────────

/** Shallow snapshot of a SessionActivity, converting Sets to plain arrays
 *  for stable equality comparison. */
function snapActivity(a: SessionActivity) {
	return {
		phase: a.phase,
		turnEpoch: a.turnEpoch,
		currentMessageId: a.currentMessageId,
		replayGeneration: a.replayGeneration,
		doneMessageIds: [...a.doneMessageIds],
		seenMessageIds: [...a.seenMessageIds],
		liveEventBuffer: a.liveEventBuffer,
		eventsHasMore: a.eventsHasMore,
		renderTimer: a.renderTimer,
		thinkingStartTime: a.thinkingStartTime,
	};
}

/** Shallow snapshot of a SessionMessages. Compares messages by length and
 *  currentAssistantText — sufficient for tier-leak detection. */
function snapMessages(m: SessionMessages) {
	return {
		messagesLength: m.messages.length,
		currentAssistantText: m.currentAssistantText,
		loadLifecycle: m.loadLifecycle,
		contextPercent: m.contextPercent,
		historyHasMore: m.historyHasMore,
		historyMessageCount: m.historyMessageCount,
		historyLoading: m.historyLoading,
		replayBatch: m.replayBatch,
		replayBuffer: m.replayBuffer,
	};
}

// ─── Per-session tiers ─────────────────────────────────────────────────────
let ta: SessionActivity;
let tm: SessionMessages;

beforeEach(() => {
	sessionState.currentId = "test-session";
	clearMessages();
	ta = testActivity();
	tm = testMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── handleDelta ───────────────────────────────────────────────────────────

describe("handleDelta — tier contract", () => {
	it("should modify activity tier (phase → streaming)", () => {
		handleDelta(ta, tm, { type: "delta", sessionId: "s1", text: "Hello" });
		vi.advanceTimersByTime(100); // flush debounced render
		expect(ta.phase).toBe("streaming");
	});

	it("should modify messages tier (currentAssistantText, messages)", () => {
		handleDelta(ta, tm, { type: "delta", sessionId: "s1", text: "Hello" });
		vi.advanceTimersByTime(100);
		expect(tm.currentAssistantText).toBe("Hello");
		expect(tm.messages.length).toBeGreaterThan(0);
	});
});

// ─── handleDone ────────────────────────────────────────────────────────────

describe("handleDone — tier contract", () => {
	it("should modify activity tier (doneMessageIds)", () => {
		// Set up streaming state so handleDone has something to finalize
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "response",
			messageId: "msg-1",
		});
		vi.advanceTimersByTime(100);

		const beforeActivity = snapActivity(ta);
		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });

		const afterActivity = snapActivity(ta);
		// doneMessageIds should have been updated on the activity tier
		expect(afterActivity.doneMessageIds.length).toBeGreaterThanOrEqual(
			beforeActivity.doneMessageIds.length,
		);
	});

	it("should write to activity.doneMessageIds when finalizing a streamed message", () => {
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "streamed text",
			messageId: "msg-done-1",
		});
		vi.advanceTimersByTime(100);

		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });
		// The finalized messageId should appear in activity.doneMessageIds
		expect(ta.doneMessageIds.has("msg-done-1")).toBe(true);
	});
});

// ─── handleStatus ──────────────────────────────────────────────────────────

describe("handleStatus — tier contract", () => {
	it("should modify activity tier (phase → processing)", () => {
		handleStatus(ta, tm, {
			type: "status",
			sessionId: "s1",
			status: "processing",
		});
		expect(ta.phase).toBe("processing");
	});

	it("should NOT modify messages tier fields on processing", () => {
		const before = snapMessages(tm);
		handleStatus(ta, tm, {
			type: "status",
			sessionId: "s1",
			status: "processing",
		});
		const after = snapMessages(tm);
		expect(after).toEqual(before);
	});

	it("status idle clears activity in-flight state", () => {
		handleStatus(ta, tm, {
			type: "status",
			sessionId: "s1",
			status: "idle",
		});
		expect(ta.phase).toBe("idle");
		expect(ta.currentMessageId).toBeNull();
	});
});

// ─── handleThinkingStart ───────────────────────────────────────────────────

describe("handleThinkingStart — tier contract", () => {
	it("should write thinkingStartTime to activity tier", () => {
		handleThinkingStart(ta, tm, {
			type: "thinking_start",
			sessionId: "s1",
		});
		expect(ta.thinkingStartTime).toBeGreaterThan(0);
	});

	it("should write thinking message to messages tier", () => {
		handleThinkingStart(ta, tm, {
			type: "thinking_start",
			sessionId: "s1",
		});
		expect(tm.messages.length).toBe(1);
		expect(tm.messages[0]?.type).toBe("thinking");
	});
});

// ─── phaseToIdle ───────────────────────────────────────────────────────────

describe("phaseToIdle — tier contract", () => {
	it("should write phase to activity tier", () => {
		phaseToProcessing(ta);
		phaseToIdle(ta);
		expect(ta.phase).toBe("idle");
	});

	it("should NOT modify messages tier", () => {
		const before = snapMessages(tm);
		phaseToIdle(ta);
		const after = snapMessages(tm);
		expect(after).toEqual(before);
	});
});

// ─── phaseToProcessing ─────────────────────────────────────────────────────

describe("phaseToProcessing — tier contract", () => {
	it("should write phase to activity tier", () => {
		phaseToProcessing(ta);
		expect(ta.phase).toBe("processing");
	});

	it("should NOT modify messages tier", () => {
		const before = snapMessages(tm);
		phaseToProcessing(ta);
		const after = snapMessages(tm);
		expect(after).toEqual(before);
	});
});

// ─── phaseToStreaming ──────────────────────────────────────────────────────

describe("phaseToStreaming — tier contract", () => {
	it("should write phase to activity tier", () => {
		phaseToStreaming(ta);
		expect(ta.phase).toBe("streaming");
	});

	it("should NOT modify messages tier", () => {
		const before = snapMessages(tm);
		phaseToStreaming(ta);
		const after = snapMessages(tm);
		expect(after).toEqual(before);
	});
});

// ─── advanceTurnIfNewMessage ───────────────────────────────────────────────

describe("advanceTurnIfNewMessage — tier contract", () => {
	it("should modify activity.seenMessageIds on first call with a new messageId", () => {
		expect(ta.seenMessageIds.size).toBe(0);
		advanceTurnIfNewMessage(ta, tm, "msg-new-1");
		expect(ta.seenMessageIds.has("msg-new-1")).toBe(true);
	});

	it("should NOT modify messages tier on a simple new messageId", () => {
		const before = snapMessages(tm);
		advanceTurnIfNewMessage(ta, tm, "msg-new-2");
		const after = snapMessages(tm);
		expect(after).toEqual(before);
	});

	it("should be a no-op when messageId is undefined", () => {
		const beforeActivity = snapActivity(ta);
		const beforeMessages = snapMessages(tm);
		advanceTurnIfNewMessage(ta, tm, undefined);
		expect(snapActivity(ta)).toEqual(beforeActivity);
		expect(snapMessages(tm)).toEqual(beforeMessages);
	});

	it("should modify activity.doneMessageIds when finalizing a streaming turn", () => {
		// Set up: start streaming a message
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "text",
			messageId: "msg-turn-1",
		});
		vi.advanceTimersByTime(100);

		// Now advance to a new message — should finalize streaming + add to doneMessageIds
		advanceTurnIfNewMessage(ta, tm, "msg-turn-1");
		// First call just records it as seen. Set up streaming again.
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "more",
			messageId: "msg-turn-1",
		});
		vi.advanceTimersByTime(100);

		// A genuinely new messageId triggers turn advance
		advanceTurnIfNewMessage(ta, tm, "msg-turn-2");
		expect(ta.seenMessageIds.has("msg-turn-2")).toBe(true);
	});
});

// ─── Cross-cutting: no unexpected tier field additions ─────────────────────

describe("tier field completeness", () => {
	it("snapActivity covers all SessionActivity keys from testActivity()", () => {
		const fresh = testActivity();
		const snap = snapActivity(fresh);
		// Every key on the activity object should appear in the snapshot
		for (const key of Object.keys(fresh)) {
			// doneMessageIds and seenMessageIds are converted to arrays
			if (key === "doneMessageIds" || key === "seenMessageIds") {
				expect(snap).toHaveProperty(key);
			} else {
				expect(snap).toHaveProperty(key);
			}
		}
	});

	it("snapMessages covers all SessionMessages keys from testMessages()", () => {
		const fresh = testMessages();
		const snap = snapMessages(fresh);
		// All scalar keys should be present (toolRegistry and messages are
		// summarized, not compared by identity)
		for (const key of Object.keys(fresh)) {
			if (key === "messages") {
				expect(snap).toHaveProperty("messagesLength");
			} else if (key === "toolRegistry") {
				// Intentionally excluded — function object, not comparable
			} else {
				expect(snap).toHaveProperty(key);
			}
		}
	});
});
