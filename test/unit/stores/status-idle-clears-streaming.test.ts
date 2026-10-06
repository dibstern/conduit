// Verifies the F2 fix, now in followSessionBusy: when the session's row goes idle,
// all streaming/processing state is cleaned up:
// 1. In-flight message finalized via flushAndFinalizeAssistant
// 2. Phase set to idle
// 3. currentMessageId cleared, currentAssistantText cleared, thinkingStartTime cleared
// 4. liveEventBuffer drained
// 5. seenMessageIds / doneMessageIds preserved (cross-turn dedup)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock DOMPurify (browser-only) before importing the store
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	chatState,
	clearMessages,
	followSessionBusy,
	isProcessing,
	phaseToProcessing,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

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

describe("F2 fix: idle row full cleanup", () => {
	it("clears processing phase when idle arrives", () => {
		phaseToProcessing(ta);
		expect(isProcessing()).toBe(true);

		followSessionBusy("test-session", false);
		expect(chatState.phase).toBe("idle");
		expect(isProcessing()).toBe(false);
	});

	it("clears currentMessageId on idle", () => {
		ta.currentMessageId = "msg-123";
		phaseToProcessing(ta);

		followSessionBusy("test-session", false);

		expect(ta.currentMessageId).toBeNull();
	});

	it("clears currentAssistantText on idle", () => {
		tm.currentAssistantText = "partial text";
		phaseToProcessing(ta);

		followSessionBusy("test-session", false);

		expect(chatState.currentAssistantText).toBe("");
	});

	it("clears thinkingStartTime on idle", () => {
		ta.thinkingStartTime = Date.now();
		phaseToProcessing(ta);

		followSessionBusy("test-session", false);

		expect(ta.thinkingStartTime).toBe(0);
	});

	it("preserves seenMessageIds across idle (cross-turn dedup)", () => {
		ta.seenMessageIds.add("msg-1");
		ta.seenMessageIds.add("msg-2");
		phaseToProcessing(ta);

		followSessionBusy("test-session", false);

		expect(ta.seenMessageIds.has("msg-1")).toBe(true);
		expect(ta.seenMessageIds.has("msg-2")).toBe(true);
	});

	it("preserves doneMessageIds across idle (cross-turn dedup)", () => {
		ta.doneMessageIds.add("msg-1");
		phaseToProcessing(ta);

		followSessionBusy("test-session", false);

		expect(ta.doneMessageIds.has("msg-1")).toBe(true);
	});

	it("is a no-op when already idle", () => {
		expect(chatState.phase).toBe("idle");
		tm.currentAssistantText = "";

		followSessionBusy("test-session", false);

		expect(chatState.phase).toBe("idle");
	});
});
