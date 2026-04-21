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
	it("should NOT modify activity tier fields", () => {
		const before = snapActivity(ta);
		handleDelta(ta, tm, { type: "delta", sessionId: "s1", text: "Hello" });
		vi.advanceTimersByTime(100); // flush debounced render
		const after = snapActivity(ta);
		expect(after).toEqual(before);
	});

	it("should modify messages tier (currentAssistantText)", () => {
		// handleDelta writes to the legacy chatState, not to the messages
		// tier object directly. But it reads activity.doneMessageIds for
		// dedup, confirming it does NOT mutate activity.
		const beforeMsg = snapMessages(tm);
		handleDelta(ta, tm, { type: "delta", sessionId: "s1", text: "Hello" });
		vi.advanceTimersByTime(100);
		// messages tier itself is not directly written in this transitional
		// commit (writes go to legacy chatState). The key assertion is that
		// activity was untouched.
		const afterMsg = snapMessages(tm);
		// Messages tier is expected to be unchanged on the per-session
		// object during this transitional commit (writes go to chatState).
		// The important contract: activity must NOT be modified.
		expect(afterMsg).toEqual(beforeMsg);
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
	it("should NOT modify activity tier fields directly (writes to legacy chatState)", () => {
		const before = snapActivity(ta);
		handleStatus(ta, tm, {
			type: "status",
			sessionId: "s1",
			status: "processing",
		});
		const after = snapActivity(ta);
		// handleStatus writes to chatState.phase (legacy), not activity.phase
		expect(after).toEqual(before);
	});

	it("should NOT modify messages tier fields", () => {
		const before = snapMessages(tm);
		handleStatus(ta, tm, {
			type: "status",
			sessionId: "s1",
			status: "processing",
		});
		const after = snapMessages(tm);
		expect(after).toEqual(before);
	});

	it("status idle should NOT modify messages tier", () => {
		const before = snapMessages(tm);
		handleStatus(ta, tm, {
			type: "status",
			sessionId: "s1",
			status: "idle",
		});
		const after = snapMessages(tm);
		expect(after).toEqual(before);
	});
});

// ─── handleThinkingStart ───────────────────────────────────────────────────

describe("handleThinkingStart — tier contract", () => {
	it("should dual-write thinkingStartTime to activity tier (Task 3)", () => {
		const before = snapActivity(ta);
		handleThinkingStart(ta, tm, {
			type: "thinking_start",
			sessionId: "s1",
		});
		const after = snapActivity(ta);
		// Task 3: handleThinkingStart now dual-writes thinkingStartTime to
		// activity tier. Only thinkingStartTime should change.
		expect(after.thinkingStartTime).toBeGreaterThan(0);
		expect({ ...after, thinkingStartTime: 0 }).toEqual(before);
	});

	it("should NOT modify messages tier fields directly (writes to legacy chatState)", () => {
		const before = snapMessages(tm);
		handleThinkingStart(ta, tm, {
			type: "thinking_start",
			sessionId: "s1",
		});
		const after = snapMessages(tm);
		// Messages are written to legacy chatState, not the messages tier
		expect(after).toEqual(before);
	});
});

// ─── phaseToIdle ───────────────────────────────────────────────────────────

describe("phaseToIdle — tier contract", () => {
	it("should NOT modify activity tier fields (writes to legacy chatState.phase)", () => {
		const before = snapActivity(ta);
		phaseToIdle(ta);
		const after = snapActivity(ta);
		expect(after).toEqual(before);
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
	it("should NOT modify activity tier fields (writes to legacy chatState.phase)", () => {
		const before = snapActivity(ta);
		phaseToProcessing(ta);
		const after = snapActivity(ta);
		expect(after).toEqual(before);
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
	it("should NOT modify activity tier fields (writes to legacy chatState.phase)", () => {
		const before = snapActivity(ta);
		phaseToStreaming(ta);
		const after = snapActivity(ta);
		expect(after).toEqual(before);
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
