import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	let store: Record<string, string> = {};
	Object.defineProperty(globalThis, "localStorage", {
		value: {
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
		},
		writable: true,
		configurable: true,
	});
});

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	clearSessionChatState,
	currentChat,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	applySessionUpsert,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";

const SESSION_ID = "assistant-part-identity";

beforeEach(() => {
	vi.useFakeTimers();
	clearSessionChatState(SESSION_ID);
	applySessionUpsert({ id: SESSION_ID, title: "", status: "idle" });
	sessionState.currentId = SESSION_ID;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Regression: assistant text identity follows server part id", () => {
	it("resumes a history text part when live deltas continue it", async () => {
		handleMessage({
			type: "session_switched",
			id: SESSION_ID,
			sessionId: SESSION_ID,
			history: {
				messages: [
					{
						id: "U",
						role: "user",
						parts: [{ id: "UP", type: "text", text: "Complete this" }],
					},
					{
						id: "M",
						role: "assistant",
						time: { created: 1234 },
						parts: [{ id: "P", type: "text", text: "Hello, wor" }],
					},
				],
				hasMore: false,
			},
		});
		await vi.runAllTimersAsync();

		handleMessage({
			type: "delta",
			sessionId: SESSION_ID,
			messageId: "M",
			partId: "P",
			text: "ld.",
		});
		vi.advanceTimersByTime(100);
		handleMessage({
			type: "done",
			sessionId: SESSION_ID,
			code: 0,
		});

		const chat = currentChat();
		const assistantMessages = chat.messages.filter(
			(message) => message.type === "assistant",
		);
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0]).toMatchObject({
			messageId: "M",
			partId: "P",
			rawText: "Hello, world.",
			finalized: true,
			createdAt: 1234,
		});
		expect(chat.messages.map((message) => message.type)).toEqual([
			"user",
			"assistant",
		]);
		expect(chat.turnEpoch).toBe(1);
	});

	it("starts a new assistant message for a different part id", () => {
		handleMessage({
			type: "delta",
			sessionId: SESSION_ID,
			messageId: "M",
			partId: "P",
			text: "Fir",
		});
		handleMessage({
			type: "delta",
			sessionId: SESSION_ID,
			messageId: "M",
			partId: "P",
			text: "st",
		});
		handleMessage({
			type: "delta",
			sessionId: SESSION_ID,
			messageId: "M",
			partId: "Q",
			text: "Second",
		});
		vi.advanceTimersByTime(100);

		const assistantMessages = currentChat().messages.filter(
			(message) => message.type === "assistant",
		);
		expect(assistantMessages).toHaveLength(2);
		expect(assistantMessages).toMatchObject([
			{ partId: "P", rawText: "First" },
			{ partId: "Q", rawText: "Second" },
		]);
	});

	it("keeps phase-based append behavior when deltas have no part id", () => {
		handleMessage({
			type: "delta",
			sessionId: SESSION_ID,
			text: "Hello, ",
		});
		handleMessage({
			type: "delta",
			sessionId: SESSION_ID,
			text: "world.",
		});
		vi.advanceTimersByTime(100);

		const assistantMessages = currentChat().messages.filter(
			(message) => message.type === "assistant",
		);
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0]).toMatchObject({
			rawText: "Hello, world.",
			finalized: false,
		});
	});
});
