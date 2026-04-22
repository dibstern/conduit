// ─── Async History Conversion ────────────────────────────────────────────────
// Verifies the async chunked convertHistoryAsync implementation:
// - Small history produces same result as direct historyToChatMessages
// - Large history (200+ messages) produces same result
// - history_page sets loading=false even on abort (session switch during conversion)

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
	historyState,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeHistoryMessage(
	id: string,
	role: "user" | "assistant",
	text: string,
): HistoryMessage {
	return {
		id,
		role,
		parts: [{ id: `${id}-p1`, type: "text", text }],
	} as HistoryMessage;
}

function makeHistoryPair(index: number): HistoryMessage[] {
	return [
		makeHistoryMessage(`u${index}`, "user", `question ${index}`),
		makeHistoryMessage(`a${index}`, "assistant", `answer ${index}`),
	];
}

/** Identity render function (no markdown processing) */
const identityRender = (text: string) => text;

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	sessionState.rootSessions = [];
	sessionState.allSessions = [];
	sessionState.searchResults = null;
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	sessionState.hasMore = false;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Async history conversion: correctness", () => {
	it("small history produces same result as direct historyToChatMessages", async () => {
		const messages: HistoryMessage[] = [
			makeHistoryMessage("m1", "user", "hello"),
			makeHistoryMessage("m2", "assistant", "world"),
		];

		// Direct (synchronous) conversion for reference
		const directResult = historyToChatMessages(messages, identityRender);

		// Async path via handleMessage (session_switched with history)
		handleMessage({
			type: "session_switched",
			id: "s1",
			sessionId: "s1",
			history: {
				messages,
				hasMore: false,
			},
		});
		await vi.runAllTimersAsync();

		// Compare structure (ignoring uuids which are randomly generated)
		expect(chatState.messages.length).toBe(directResult.length);
		for (let i = 0; i < directResult.length; i++) {
			expect(chatState.messages[i]?.type).toBe(directResult[i]?.type);
			if (chatState.messages[i]?.type === "user") {
				expect((chatState.messages[i] as { text: string }).text).toBe(
					(directResult[i] as { text: string }).text,
				);
			}
			if (chatState.messages[i]?.type === "assistant") {
				expect((chatState.messages[i] as { rawText: string }).rawText).toBe(
					(directResult[i] as { rawText: string }).rawText,
				);
			}
		}
	});

	it("large history (200+ messages) produces same result", async () => {
		const messages: HistoryMessage[] = [];
		for (let i = 0; i < 110; i++) {
			messages.push(...makeHistoryPair(i));
		}
		// 220 HistoryMessages total (110 pairs)

		const directResult = historyToChatMessages(messages, identityRender);

		handleMessage({
			type: "session_switched",
			id: "s2",
			sessionId: "s2",
			history: {
				messages,
				hasMore: false,
			},
		});
		await vi.runAllTimersAsync();

		// Same number of ChatMessages
		expect(chatState.messages.length).toBe(directResult.length);

		// Spot-check first and last messages
		expect(chatState.messages[0]?.type).toBe("user");
		expect((chatState.messages[0] as { text: string }).text).toBe("question 0");

		const lastUser = chatState.messages.filter((m) => m.type === "user");
		expect((lastUser[lastUser.length - 1] as { text: string }).text).toBe(
			"question 109",
		);

		const lastAssistant = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(
			(lastAssistant[lastAssistant.length - 1] as { rawText: string }).rawText,
		).toBe("answer 109");
	});

	it("history_page also converts correctly via async path", async () => {
		// Seed with a session
		handleMessage({ type: "session_switched", id: "s3", sessionId: "s3" });

		const messages: HistoryMessage[] = [
			makeHistoryMessage("m1", "user", "older question"),
			makeHistoryMessage("m2", "assistant", "older answer"),
		];

		historyState.loading = true;
		handleMessage({
			type: "history_page",
			sessionId: "s3",
			messages,
			hasMore: true,
		});
		await vi.runAllTimersAsync();

		expect(chatState.messages.length).toBeGreaterThan(0);
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("older question");
		expect(historyState.loading).toBe(false);
		expect(historyState.hasMore).toBe(true);
	});
});

describe("Async history conversion: abort handling", () => {
	it("history_page sets loading=false even on abort (session switch during conversion)", async () => {
		// Start with a session and set loading state
		handleMessage({
			type: "session_switched",
			id: "s-original",
			sessionId: "s-original",
		});
		historyState.loading = true;

		// Send a large history_page that will take multiple chunks
		const messages: HistoryMessage[] = [];
		for (let i = 0; i < 60; i++) {
			messages.push(...makeHistoryPair(i));
		}

		handleMessage({
			type: "history_page",
			sessionId: "s-original",
			messages,
			hasMore: true,
		});

		// Session switch mid-conversion: clearMessages bumps replayGeneration
		handleMessage({
			type: "session_switched",
			id: "s-new",
			sessionId: "s-new",
		});

		await vi.runAllTimersAsync();

		// CRITICAL: loading must be false even though conversion was aborted
		expect(historyState.loading).toBe(false);
		// Session switched to new, so currentId should be the new one
		expect(sessionState.currentId).toBe("s-new");
	});

	it("session_switched with large history aborted by rapid switch does not prepend stale messages", async () => {
		// Build a history larger than CHUNK (50) so conversion must yield
		const firstMessages: HistoryMessage[] = [];
		for (let i = 0; i < 60; i++) {
			firstMessages.push(
				makeHistoryMessage(`f${i}`, "user", `from first ${i}`),
			);
		}

		// First switch with large history
		handleMessage({
			type: "session_switched",
			id: "s-first",
			sessionId: "s-first",
			history: {
				messages: firstMessages,
				hasMore: false,
			},
		});

		// Rapid switch before first conversion completes (clearMessages bumps replayGeneration)
		handleMessage({
			type: "session_switched",
			id: "s-second",
			sessionId: "s-second",
			history: {
				messages: [makeHistoryMessage("m2", "user", "from second session")],
				hasMore: false,
			},
		});

		await vi.runAllTimersAsync();

		// Only second session's messages should be present
		expect(sessionState.currentId).toBe("s-second");
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("from second session");
	});
});
