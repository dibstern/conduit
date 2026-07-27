// ─── Regression: rest-history queued fallback false positives ────────────────
// Claude (relay-local) sessions ALWAYS reload via the `rest-history` projected
// path (see handlers/session.ts resolveSessionHistory — non-opencode returns
// projectedSource early). That path cannot infer queued state from event
// ordering, so it relies on `ensureSentDuringEpochOnLastUnrespondedUser`,
// triggered by the `status:processing` message that follows session_switched.
//
// The heavily-tested `llmActive` cached-events replay path is NOT exercised on
// a Claude reload, so these cases were never covered. The fallback decides a
// user message is "unresponded" by checking for a following ChatMessage of
// type "assistant" — but historyToChatMessages only emits type:"assistant" for
// TEXT parts. A turn answered with only tool calls or only thinking (common for
// a coding agent) produces no "assistant" message, so an ANSWERED message is
// mistaken for a queued one and shimmers "Queued" after navigating back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	default: { sanitize: (html: string) => html },
}));

import {
	chatState,
	clearMessages,
	getMessages,
	handleStatus,
	markPendingHistoryQueuedFallback,
	type SessionActivity,
	type SessionMessages,
	setMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import type {
	HistoryMessage,
	UserMessage,
} from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

let ta: SessionActivity;
let tm: SessionMessages;

beforeEach(() => {
	sessionState.currentId = "test-session";
	sessionState.sessions.set("test-session", { id: "test-session", title: "" });
	clearMessages();
	ta = testActivity();
	tm = testMessages();
});

/** Mirrors the derived visual logic in UserMessage.svelte. */
function isVisuallyQueued(msg: UserMessage): boolean {
	return (
		msg.sentDuringEpoch != null && chatState.turnEpoch <= msg.sentDuringEpoch
	);
}

function lastUser(): UserMessage {
	const users = getMessages(tm).filter(
		(m): m is UserMessage => m.type === "user",
	);
	// biome-ignore lint/style/noNonNullAssertion: test guarantees a user message
	return users[users.length - 1]!;
}

/** Simulate the Claude reload path: rest-history converts to ChatMessages,
 *  marks the queued fallback, then the trailing status:processing fires. */
function reloadThenProcessing(history: HistoryMessage[]): void {
	const chatMsgs = historyToChatMessages(history);
	setMessages(tm, chatMsgs);
	markPendingHistoryQueuedFallback();
	handleStatus(ta, tm, {
		type: "status",
		sessionId: "test-session",
		status: "processing",
	});
}

describe("rest-history queued fallback: answered turns must not shimmer", () => {
	it("does NOT flag a message answered with assistant TEXT", () => {
		reloadThenProcessing([
			{
				id: "u1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "hi" }],
			},
			{
				id: "a1",
				role: "assistant",
				parts: [{ id: "p2", type: "text", text: "hello there" }],
			},
		]);
		expect(lastUser().sentDuringEpoch).toBeUndefined();
		expect(isVisuallyQueued(lastUser())).toBe(false);
	});

	it("does NOT flag a message answered with ONLY a tool call", () => {
		// A coding-agent turn that runs a tool with no narration text.
		reloadThenProcessing([
			{
				id: "u1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "edit the file" }],
			},
			{
				id: "a1",
				role: "assistant",
				parts: [
					{
						id: "p2",
						type: "tool",
						tool: "Edit",
						callID: "c1",
						state: { status: "completed", output: "ok" },
					},
				],
			},
		]);
		expect(lastUser().sentDuringEpoch).toBeUndefined();
		expect(isVisuallyQueued(lastUser())).toBe(false);
	});

	it("does NOT flag a message answered with ONLY thinking", () => {
		reloadThenProcessing([
			{
				id: "u1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "think about it" }],
			},
			{
				id: "a1",
				role: "assistant",
				parts: [{ id: "p2", type: "thinking", text: "hmm..." }],
			},
		]);
		expect(lastUser().sentDuringEpoch).toBeUndefined();
		expect(isVisuallyQueued(lastUser())).toBe(false);
	});

	it("STILL flags a genuinely unresponded trailing message", () => {
		// Sanity: the fallback must keep working for real queued messages.
		reloadThenProcessing([
			{
				id: "u1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "first" }],
			},
			{
				id: "a1",
				role: "assistant",
				parts: [{ id: "p2", type: "text", text: "answer to first" }],
			},
			{
				id: "u2",
				role: "user",
				parts: [{ id: "p3", type: "text", text: "second (still queued)" }],
			},
		]);
		expect(lastUser().sentDuringEpoch).toBe(chatState.turnEpoch);
		expect(isVisuallyQueued(lastUser())).toBe(true);
	});
});
