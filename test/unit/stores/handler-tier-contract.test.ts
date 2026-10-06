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
	followSessionBusy,
	phaseToIdle,
	phaseToProcessing,
	phaseToStreaming,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

/** Shallow snapshot of a SessionActivity, converting Sets to plain arrays
 *  for stable equality comparison. */
function snapActivity(a: SessionActivity) {
	return {
		phase: a.phase,
		turnEpoch: a.turnEpoch,
		turnGeneration: a.turnGeneration,
		endedGeneration: a.endedGeneration,
		terminalTurnIds: [...a.terminalTurnIds],
		currentMessageId: a.currentMessageId,
		currentPartId: a.currentPartId,
		replayGeneration: a.replayGeneration,
		doneMessageIds: [...a.doneMessageIds],
		seenMessageIds: [...a.seenMessageIds],
		renderTimer: a.renderTimer,
		thinkingStartTime: a.thinkingStartTime,
	};
}

/** Shallow snapshot of a SessionMessages. Compares messages by length and
 *  currentAssistantText — sufficient for tier-leak detection. */
function snapMessages(m: SessionMessages) {
	return {
		messagesLength: m.messages.length,
		transcript: m.transcript,
		currentAssistantText: m.currentAssistantText,
		loadLifecycle: m.loadLifecycle,
		contextPercent: m.contextPercent,
		historyHasMore: m.historyHasMore,
		historyLoading: m.historyLoading,
	};
}

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

describe("followSessionBusy — tier contract", () => {
	it("should modify activity tier (phase → processing)", () => {
		followSessionBusy("test-session", true);
		expect(ta.phase).toBe("processing");
	});

	it("should NOT modify messages tier fields on processing", () => {
		const before = snapMessages(tm);
		followSessionBusy("test-session", true);
		const after = snapMessages(tm);
		expect(after).toEqual(before);
	});

	it("an idle row clears activity in-flight state", () => {
		followSessionBusy("test-session", false);
		expect(ta.phase).toBe("idle");
		expect(ta.currentMessageId).toBeNull();
	});
});

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
});

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
