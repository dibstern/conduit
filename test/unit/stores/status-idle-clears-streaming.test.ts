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
	handleDelta,
	handleStatus,
	isProcessing,
	isStreaming,
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

	it("clears streaming phase when idle arrives (F2 fix)", () => {
		// Start streaming
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "streaming text",
		});
		expect(isStreaming()).toBe(true);

		// Server says idle — should force cleanup
		handleStatus(ta, tm, statusMsg("idle"));
		expect(chatState.phase).toBe("idle");
		expect(isStreaming()).toBe(false);
	});

	it("finalizes in-flight assistant message when streaming and idle arrives", () => {
		// Simulate an in-flight message
		ta.currentMessageId = "msg-1";
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "partial response",
		});
		expect(chatState.phase).toBe("streaming");

		// Flush the render timer so the assistant message has content
		vi.advanceTimersByTime(100);

		handleStatus(ta, tm, statusMsg("idle"));

		// Phase should be idle
		expect(chatState.phase).toBe("idle");

		// The assistant message should be finalized
		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — checked above
		expect(assistantMsgs[0]!.type).toBe("assistant");
	});

	it("clears currentMessageId on idle", () => {
		ta.currentMessageId = "msg-123";
		chatState.currentMessageId = "msg-123";
		phaseToProcessing(ta);

		handleStatus(ta, tm, statusMsg("idle"));

		expect(ta.currentMessageId).toBeNull();
	});

	it("clears currentAssistantText on idle", () => {
		chatState.currentAssistantText = "partial text";
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

	it("drains liveEventBuffer on idle", () => {
		ta.liveEventBuffer = [{ type: "delta", sessionId: "s1", text: "buffered" }];
		phaseToProcessing(ta);

		handleStatus(ta, tm, statusMsg("idle"));

		expect(ta.liveEventBuffer).toBeNull();
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
		chatState.currentAssistantText = "";

		handleStatus(ta, tm, statusMsg("idle"));

		expect(chatState.phase).toBe("idle");
	});

	it("does not downgrade streaming to processing on status:processing", () => {
		// Start streaming
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "still streaming",
		});
		expect(isStreaming()).toBe(true);

		// status:processing should NOT downgrade
		handleStatus(ta, tm, statusMsg("processing"));
		expect(isStreaming()).toBe(true);
	});
});
