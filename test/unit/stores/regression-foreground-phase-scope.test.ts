// ─── Regression: foreground phase flags must not decide background state ─────
// The global phase flags (isProcessing/isStreaming/…) describe the session on
// screen.  Two paths used to read them for work that belongs to another
// session — or to a socket that just closed — and silently corrupted turn
// bookkeeping:
//
//  1. ws-dispatch's `user_message` arm passed `isProcessing()` as the queued
//     flag for *the event's* session.  With A on screen and idle while B
//     streams, B's queued message lost its `sentDuringEpoch` marker and B's
//     assistant was finalized mid-stream.
//  2. The socket-close handler idled the current session's phase directly, so
//     the `status:idle` that follows reconnection saw an already-idle slot,
//     skipped `finalizeTurn`, and never bumped `turnEpoch` — leaving the
//     queued user message rendered as queued forever.

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
	default: { sanitize: (html: string) => html },
}));

import {
	clearMessages,
	getOrCreateSessionSlot,
	phaseCurrentSessionToIdle,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type {
	AssistantMessage,
	ChatMessage,
	UserMessage,
} from "../../../src/lib/frontend/types.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

function lastUser(messages: ChatMessage[]): UserMessage {
	const found = [...messages]
		.reverse()
		.find((message): message is UserMessage => message.type === "user");
	if (!found) throw new Error("no user message in slot");
	return found;
}

function lastAssistant(messages: ChatMessage[]): AssistantMessage {
	const found = [...messages]
		.reverse()
		.find(
			(message): message is AssistantMessage => message.type === "assistant",
		);
	if (!found) throw new Error("no assistant message in slot");
	return found;
}

beforeEach(() => {
	clearMessages();
	sessionState.currentId = "session-a";
	for (const id of ["session-a", "session-b"]) {
		sessionState.sessions.set(id, { id, title: "" });
	}
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	clearMessages();
	sessionActivity.clear();
	sessionMessages.clear();
	sessionState.sessions.clear();
});

describe("queued state comes from the event's session, not the foreground", () => {
	it("keeps sentDuringEpoch and keeps B streaming while idle A is on screen", () => {
		// A is on screen and idle; B is streaming in the background.
		const slotA = getOrCreateSessionSlot("session-a");
		handleMessage({
			type: "delta",
			sessionId: "session-b",
			text: "B is mid-answer",
		} as RelayMessage);
		const slotB = getOrCreateSessionSlot("session-b");
		expect(slotA.activity.phase).toBe("idle");
		expect(slotB.activity.phase).toBe("streaming");

		// A message arrives for B while B is still streaming: it is queued.
		handleMessage({
			type: "user_message",
			sessionId: "session-b",
			text: "queued for B",
			messageId: "user-b-1",
		} as RelayMessage);

		expect(lastUser(slotB.messages.messages).sentDuringEpoch).toBe(
			slotB.activity.turnEpoch,
		);
		// B's turn is not over: its assistant text stays live and unfinalized.
		expect(slotB.activity.phase).toBe("streaming");
		expect(slotB.messages.currentAssistantText).toBe("B is mid-answer");
	});

	it("does not queue a message for an idle background session", () => {
		// B exists but is idle; A (on screen) is streaming.
		getOrCreateSessionSlot("session-b");
		handleMessage({
			type: "delta",
			sessionId: "session-a",
			text: "A is mid-answer",
		} as RelayMessage);

		handleMessage({
			type: "user_message",
			sessionId: "session-b",
			text: "not queued",
			messageId: "user-b-2",
		} as RelayMessage);

		const slotB = getOrCreateSessionSlot("session-b");
		expect(lastUser(slotB.messages.messages).sentDuringEpoch).toBeUndefined();
	});
});

describe("socket close ends the turn instead of only idling the phase", () => {
	it("bumps turnEpoch so the queued message stops rendering as queued", () => {
		handleMessage({
			type: "delta",
			sessionId: "session-a",
			text: "A is mid-answer",
		} as RelayMessage);
		handleMessage({
			type: "user_message",
			sessionId: "session-a",
			text: "queued for A",
			messageId: "user-a-1",
		} as RelayMessage);

		const slotA = getOrCreateSessionSlot("session-a");
		const queued = lastUser(slotA.messages.messages);
		expect(queued.sentDuringEpoch).toBe(0);
		expect(slotA.activity.turnEpoch).toBe(0);

		// Socket drops mid-turn, then the relay reports idle on reconnect.
		phaseCurrentSessionToIdle();
		handleMessage({
			type: "status",
			sessionId: "session-a",
			status: "idle",
		} as RelayMessage);

		expect(slotA.activity.phase).toBe("idle");
		expect(slotA.activity.turnEpoch).toBe(1);
		// UserMessage.svelte's queued predicate: turnEpoch <= sentDuringEpoch.
		expect(slotA.activity.turnEpoch).toBeGreaterThan(
			queued.sentDuringEpoch ?? -1,
		);
	});

	it("does not bump turnEpoch twice when idle arrives after a clean close", () => {
		handleMessage({
			type: "delta",
			sessionId: "session-a",
			text: "A is mid-answer",
		} as RelayMessage);
		handleMessage({
			type: "done",
			sessionId: "session-a",
			code: 0,
		} as RelayMessage);
		const slotA = getOrCreateSessionSlot("session-a");
		expect(slotA.activity.turnEpoch).toBe(1);

		phaseCurrentSessionToIdle();
		handleMessage({
			type: "status",
			sessionId: "session-a",
			status: "idle",
		} as RelayMessage);

		expect(slotA.activity.turnEpoch).toBe(1);
	});
});

describe("socket close still cleans up the assistant in flight", () => {
	it("finalizes and flushes the identified assistant, bumping the epoch once", () => {
		// A streaming assistant message with an identity, exactly as dispatch
		// builds it (advanceTurnIfNewMessage on messageId/partId).
		handleMessage({
			type: "delta",
			sessionId: "session-a",
			text: "half an answer",
			messageId: "msg_1",
			partId: "part_1",
		} as RelayMessage);

		const slotA = getOrCreateSessionSlot("session-a");
		expect(slotA.activity.phase).toBe("streaming");
		expect(slotA.activity.currentMessageId).toBe("msg_1");
		expect(slotA.activity.currentPartId).toBe("part_1");
		expect(lastAssistant(slotA.messages.messages).finalized).toBe(false);

		// Socket drops mid-stream, then the relay reports idle on reconnect.
		phaseCurrentSessionToIdle();
		handleMessage({
			type: "status",
			sessionId: "session-a",
			status: "idle",
		} as RelayMessage);

		// The assistant is committed: Copy/Fork controls render, pending text
		// made it into the message, and the part identity is released.
		const assistant = lastAssistant(slotA.messages.messages);
		expect(assistant.finalized).toBe(true);
		expect(assistant.rawText).toContain("half an answer");
		expect(slotA.messages.currentAssistantText).toBe("");
		expect(slotA.activity.currentPartId).toBeNull();
		expect(slotA.activity.phase).toBe("idle");
		expect(slotA.activity.turnEpoch).toBe(1);
	});
});
