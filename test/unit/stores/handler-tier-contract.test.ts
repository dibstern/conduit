// @vitest-environment jsdom
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
	followSessionTurn,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	openSessionForSetup,
	WORKING_ACTIVITY,
} from "../../../src/lib/frontend/stories/session-setup.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

/** Shallow snapshot of a SessionActivity, converting Sets to plain arrays
 *  for stable equality comparison. */
function snapActivity(a: SessionActivity) {
	return {
		turnGeneration: a.turnGeneration,
		endedGeneration: a.endedGeneration,
		terminalTurnIds: [...a.terminalTurnIds],
		currentMessageId: a.currentMessageId,
		currentPartId: a.currentPartId,
		replayGeneration: a.replayGeneration,
		doneMessageIds: [...a.doneMessageIds],
		seenMessageIds: [...a.seenMessageIds],
		renderTimer: a.renderTimer,
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
	openSessionForSetup("test-session", "project-a");
	clearMessages();
	ta = testActivity();
	tm = testMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("followSessionTurn — tier contract", () => {
	const working = { activity: WORKING_ACTIVITY };

	it("a working row opens a turn in the activity tier", () => {
		ta.endedGeneration = ta.turnGeneration;
		followSessionTurn("test-session", working, undefined);
		expect(ta.turnGeneration).toBe(ta.endedGeneration + 1);
	});

	it("should NOT modify messages tier fields on a working row", () => {
		const before = snapMessages(tm);
		followSessionTurn("test-session", working, undefined);
		const after = snapMessages(tm);
		expect(after).toEqual(before);
	});

	it("a row leaving working clears activity in-flight state", () => {
		ta.currentMessageId = "msg-1";
		followSessionTurn("test-session", {}, working);
		expect(ta.endedGeneration).toBe(ta.turnGeneration);
		expect(ta.currentMessageId).toBeNull();
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
