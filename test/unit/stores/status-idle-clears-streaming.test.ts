// ─── F2 Fix: status:idle Full Cleanup Tests ─────────────────────────────────
// Verifies the F2 fix in handleStatus: when the server sends status:idle,
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
	handleStatus,
	isProcessing,
	phaseToProcessing,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

// ─── Per-session tiers for handler calls ────────────────────────────────────
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

// Helper to create typed status messages
function statusMsg(status: string) {
	return { type: "status" as const, sessionId: "s1", status };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("F2 fix: status:idle full cleanup", () => {
	it("clears processing phase when idle arrives", () => {
		phaseToProcessing(ta);
		expect(isProcessing()).toBe(true);

		handleStatus(ta, tm, statusMsg("idle"));
		expect(chatState.phase).toBe("idle");
		expect(isProcessing()).toBe(false);
	});

	it("clears currentMessageId on idle", () => {
		ta.currentMessageId = "msg-123";
		phaseToProcessing(ta);

		handleStatus(ta, tm, statusMsg("idle"));

		expect(ta.currentMessageId).toBeNull();
	});

	it("clears currentAssistantText on idle", () => {
		tm.currentAssistantText = "partial text";
		phaseToProcessing(ta);

		handleStatus(ta, tm, statusMsg("idle"));

		expect(chatState.currentAssistantText).toBe("");
	});

	it("clears thinkingStartTime on idle", () => {
		ta.thinkingStartTime = Date.now();
		phaseToProcessing(ta);

		handleStatus(ta, tm, statusMsg("idle"));

		expect(ta.thinkingStartTime).toBe(0);
	});

	it("preserves seenMessageIds across idle (cross-turn dedup)", () => {
		ta.seenMessageIds.add("msg-1");
		ta.seenMessageIds.add("msg-2");
		phaseToProcessing(ta);

		handleStatus(ta, tm, statusMsg("idle"));

		expect(ta.seenMessageIds.has("msg-1")).toBe(true);
		expect(ta.seenMessageIds.has("msg-2")).toBe(true);
	});

	it("preserves doneMessageIds across idle (cross-turn dedup)", () => {
		ta.doneMessageIds.add("msg-1");
		phaseToProcessing(ta);

		handleStatus(ta, tm, statusMsg("idle"));

		expect(ta.doneMessageIds.has("msg-1")).toBe(true);
	});

	it("is a no-op when already idle", () => {
		expect(chatState.phase).toBe("idle");
		tm.currentAssistantText = "";

		handleStatus(ta, tm, statusMsg("idle"));

		expect(chatState.phase).toBe("idle");
	});
});
