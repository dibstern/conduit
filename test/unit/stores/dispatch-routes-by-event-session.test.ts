// ─── Chat dispatch routes by the event's own session ────────────────────────
// ni8.5.20 / T-11 piece 4: the chat dispatcher stops resolving its target from
// a global "current slot" pointer. A replay driven for a background session
// must land in that session's slot, and must not touch the foreground pane.

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
	getMessages,
	getOrCreateSessionSlot,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { replayEvents } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";

beforeEach(() => {
	clearSessionState();
	sessionActivity.clear();
	sessionMessages.clear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

const transcript = (sessionId: string, label: string): RelayMessage[] => [
	{ type: "user_message", sessionId, text: `${label} question` },
	{
		type: "delta",
		sessionId,
		messageId: `${label}-msg`,
		text: `${label} answer`,
	} as RelayMessage,
	{ type: "done", sessionId, code: 0 } as RelayMessage,
];

const textOf = (sessionId: string): string =>
	getMessages(getOrCreateSessionSlot(sessionId).messages)
		.map((m) => (m.type === "assistant" ? m.rawText : ""))
		.join("");

describe("chat dispatch routes by the event's own session id", () => {
	it("replays a background session into its own slot, not the foreground pane", async () => {
		sessionState.currentId = "foreground";
		getOrCreateSessionSlot("foreground");
		getOrCreateSessionSlot("background");

		await replayEvents(transcript("background", "bg"), "background");
		await vi.runAllTimersAsync();

		expect(textOf("background")).toContain("bg answer");
		expect(textOf("foreground")).toBe("");
	});

	it("does not clobber the foreground transcript with a background replay", async () => {
		sessionState.currentId = "foreground";
		await replayEvents(transcript("foreground", "fg"), "foreground");
		await vi.runAllTimersAsync();
		const foregroundBefore = textOf("foreground");

		await replayEvents(transcript("background", "bg"), "background");
		await vi.runAllTimersAsync();

		expect(textOf("foreground")).toBe(foregroundBefore);
		expect(textOf("foreground")).not.toContain("bg answer");
	});

	it("replays with no session selected at all", async () => {
		sessionState.currentId = null;
		clearMessages();

		await replayEvents(transcript("orphan", "orphan"), "orphan");
		await vi.runAllTimersAsync();

		expect(textOf("orphan")).toContain("orphan answer");
	});
});
