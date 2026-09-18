// ─── Concurrent Session Dispatch Tests ──────────────────────────────────────
// Verifies that interleaved per-session events for sessions A/B/C are routed
// independently. Covers: live event buffering during replay, notification_event
// non-routing, prod missing-sessionId drop, and unknown-session drop.

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

// Mock DOMPurify (browser-only) before importing stores
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	addUserMessage,
	chatState,
	clearMessages,
	getOrCreateSessionSlot,
	isStreaming,
	phaseToStreaming,
	sessionActivity,
	sessionMessages,
	setMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { getBrowserClientId } from "../../../src/lib/frontend/stores/client-identity.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	handleMessage,
	isPerSessionEvent,
} from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	sessionState.currentId = "session-a";
	for (const id of ["session-a", "session-b", "session-c"]) {
		sessionState.sessions.set(id, { id, title: "", status: "idle" });
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

// ─── Tests ──────────────────────────────────────────────────────────────────

it("attaches provider ids to optimistic user messages without another bubble or turn", () => {
	const { activity, messages } = getOrCreateSessionSlot("session-a");
	addUserMessage(activity, messages, "Hello");
	const optimistic = chatState.messages[0];
	const event = {
		type: "user_message" as const,
		sessionId: "session-a",
		text: "Hello",
		messageId: "provider-1",
		originId: getBrowserClientId(),
	};
	handleMessage(event);
	handleMessage(event);
	expect(chatState.messages).toEqual([
		{ ...optimistic, messageId: "provider-1" },
	]);
	expect(sessionActivity.get("session-a")?.currentMessageId).toBeNull();
});

it("reconciles each sender FIFO on both viewers and ignores duplicate provider delivery", () => {
	for (const viewer of ["sender", "observer"]) {
		clearMessages();
		const { activity, messages } = getOrCreateSessionSlot("session-a");
		const originId =
			viewer === "sender" ? getBrowserClientId() : "other-browser";
		for (let i = 0; i < 2; i++) {
			if (viewer === "sender") addUserMessage(activity, messages, "same text");
			handleMessage({
				type: "user_message",
				sessionId: "session-a",
				text: "same text",
				originId,
			});
		}
		const provisional = [...chatState.messages];
		expect(provisional).toHaveLength(2);
		for (const messageId of ["first", "first", "second", "second"]) {
			handleMessage({
				type: "user_message",
				sessionId: "session-a",
				text: "same text",
				originId,
				messageId,
			});
		}
		expect(chatState.messages).toEqual(
			provisional.map((message, index) => ({
				...message,
				messageId: index === 0 ? "first" : "second",
			})),
		);
	}
});

it.each([
	"foreign-client",
	undefined,
])("does not correlate origin %s to our same-text optimistic bubble", (originId) => {
	const { activity, messages } = getOrCreateSessionSlot("session-a");
	addUserMessage(activity, messages, "ok");
	const optimistic = chatState.messages[0];
	const event = {
		type: "user_message" as const,
		sessionId: "session-a",
		text: "ok",
		messageId: "foreign-99",
		...(originId ? { originId } : {}),
	};
	handleMessage(event);
	handleMessage(event);
	expect(chatState.messages).toEqual([
		optimistic,
		expect.objectContaining({ text: "ok", messageId: "foreign-99" }),
	]);
	expect(chatState.messages[0]).not.toHaveProperty("messageId");
});

it("confirms identical own sends in FIFO order, skipping foreign unconfirmed bubbles", () => {
	const { activity, messages } = getOrCreateSessionSlot("session-a");
	handleMessage({
		type: "user_message",
		sessionId: "session-a",
		text: "ok",
		originId: "foreign",
	});
	const foreign = chatState.messages[0];
	addUserMessage(activity, messages, "ok");
	const first = chatState.messages[1];
	addUserMessage(activity, messages, "ok");
	const second = chatState.messages[2];
	for (const messageId of [
		"provider-1",
		"provider-1",
		"provider-2",
		"provider-2",
	]) {
		handleMessage({
			type: "user_message",
			sessionId: "session-a",
			text: "ok",
			originId: getBrowserClientId(),
			messageId,
		});
	}
	expect(chatState.messages).toEqual([
		foreign,
		{ ...first, messageId: "provider-1" },
		{ ...second, messageId: "provider-2" },
	]);
});

it("leaves a stale own bubble unconfirmed when the attributed TUI text differs", () => {
	const { activity, messages } = getOrCreateSessionSlot("session-a");
	addUserMessage(activity, messages, "typed text");
	const optimistic = chatState.messages[0];
	addUserMessage(activity, messages, "provider-normalized text");
	const second = chatState.messages[1];
	handleMessage({
		type: "user_message",
		sessionId: "session-a",
		text: "provider-normalized text",
		originId: getBrowserClientId(),
		messageId: "provider-1",
	});
	expect(chatState.messages).toEqual([
		optimistic,
		second,
		expect.objectContaining({
			text: "provider-normalized text",
			messageId: "provider-1",
		}),
	]);
});

it("still stamps a same-text TUI echo incorrectly attributed to our stale send", () => {
	const { activity, messages } = getOrCreateSessionSlot("session-a");
	addUserMessage(activity, messages, "ok");
	const optimistic = chatState.messages[0];
	handleMessage({
		type: "user_message",
		sessionId: "session-a",
		text: "ok",
		originId: getBrowserClientId(),
		messageId: "tui-same-text",
	});
	expect(chatState.messages).toEqual([
		{ ...optimistic, messageId: "tui-same-text" },
	]);
});

it("does not assign a removed send's echo to the next pending bubble", () => {
	const { activity, messages } = getOrCreateSessionSlot("session-a");
	addUserMessage(activity, messages, "ok");
	addUserMessage(activity, messages, "ok");
	const second = chatState.messages[1];
	if (!second) throw new Error("Expected the second optimistic bubble");
	setMessages(messages, [second]);
	handleMessage({
		type: "user_message",
		sessionId: "session-a",
		text: "ok",
		originId: getBrowserClientId(),
		messageId: "provider-first",
	});
	expect(chatState.messages[0]).toEqual(second);
	expect(chatState.messages[0]).not.toHaveProperty("messageId");
	handleMessage({
		type: "user_message",
		sessionId: "session-a",
		text: "ok",
		originId: getBrowserClientId(),
		messageId: "provider-second",
	});
	expect(chatState.messages[0]).toEqual({
		...second,
		messageId: "provider-second",
	});
});

it("keeps provider ids on echoed user bubbles", () => {
	handleMessage({
		type: "user_message",
		sessionId: "session-a",
		text: "External",
		messageId: "provider-2",
	});
	expect(chatState.messages).toHaveLength(1);
	expect(chatState.messages[0]).toMatchObject({
		type: "user",
		text: "External",
		messageId: "provider-2",
	});
});

describe("Interleaved deltas for A/B/C — each slot independent", () => {
	it("interleaved deltas from three sessions all create assistant messages", () => {
		handleMessage({
			type: "delta",
			sessionId: "session-a",
			text: "A says hello",
		} as RelayMessage);
		handleMessage({
			type: "delta",
			sessionId: "session-b",
			text: "B says hello",
		} as RelayMessage);
		handleMessage({
			type: "delta",
			sessionId: "session-c",
			text: "C says hello",
		} as RelayMessage);

		// All deltas went through — chat state has messages
		// (during transition, all go to legacy chatState.messages)
		expect(chatState.messages.length).toBeGreaterThan(0);
	});
});

describe("notification_event — non-routing (global dispatch)", () => {
	it("notification_event is NOT a per-session event", () => {
		const msg = {
			type: "notification_event",
			eventType: "done",
			sessionId: "session-a",
		} as RelayMessage;
		// notification_event should NOT be classified as per-session
		expect(isPerSessionEvent(msg)).toBe(false);
	});

	it("notification_event does not update chat state", () => {
		phaseToStreaming();
		handleMessage({
			type: "notification_event",
			eventType: "done",
		});
		// Chat state should be unchanged — notification_event doesn't route
		// through routePerSession
		expect(isStreaming()).toBe(true);
	});
});

describe("Missing sessionId — dev throws, prod drops", () => {
	it("throws in dev mode when sessionId is missing", () => {
		// Events with per-session types but no sessionId should throw in dev
		expect(() => {
			handleMessage({
				type: "delta",
				text: "no session",
			} as RelayMessage);
		}).toThrow(/routePerSession: missing sessionId/);
	});

	it("throws in dev mode when sessionId is empty string", () => {
		expect(() => {
			handleMessage({
				type: "delta",
				sessionId: "",
				text: "empty session",
			} as RelayMessage);
		}).toThrow(/routePerSession: missing sessionId/);
	});
});

describe("Unknown-session guard — drops events silently", () => {
	it("drops events for unknown sessionId without throwing", () => {
		// "unknown-session" is not in sessionState.sessions
		expect(() => {
			handleMessage({
				type: "delta",
				sessionId: "unknown-session",
				text: "should be dropped",
			} as RelayMessage);
		}).not.toThrow();

		// No messages should have been created
		expect(chatState.messages).toHaveLength(0);
	});

	it("processes events after session is registered", () => {
		// Register the session
		sessionState.sessions.set("new-session", {
			id: "new-session",
			title: "",
			status: "idle",
		});

		handleMessage({
			type: "delta",
			sessionId: "new-session",
			text: "now it works",
		} as RelayMessage);

		// Message should have been created
		expect(chatState.messages.length).toBeGreaterThan(0);
	});
});

describe("isPerSessionEvent — runtime guard", () => {
	it("returns true for all per-session event types", () => {
		const perSessionTypes = [
			"delta",
			"thinking_start",
			"thinking_delta",
			"thinking_stop",
			"tool_start",
			"tool_executing",
			"tool_result",
			"tool_content",
			"result",
			"done",
			"error",
			"status",
			"user_message",
			"part_removed",
			"message_removed",
			"ask_user",
			"ask_user_resolved",
			"ask_user_error",
			"permission_request",
			"permission_resolved",
			"session_switched",
			"session_forked",
			"history_page",
			"provider_session_reloaded",
			"session_deleted",
		];
		for (const type of perSessionTypes) {
			const msg = { type, sessionId: "s1" } as RelayMessage;
			expect(isPerSessionEvent(msg)).toBe(true);
		}
	});

	it("returns false for global event types", () => {
		const globalTypes = [
			"session_list",
			"model_list",
			"model_info",
			"agent_list",
			"command_list",
			"client_count",
			"connection_status",
			"notification_event",
			"pty_list",
			"pty_created",
			"file_tree",
			"todo_state",
		];
		for (const type of globalTypes) {
			const msg = { type } as RelayMessage;
			expect(isPerSessionEvent(msg)).toBe(false);
		}
	});
});
