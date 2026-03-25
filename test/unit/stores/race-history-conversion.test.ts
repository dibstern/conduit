// ─── Race: History Conversion .then() Callback Stale Write ──────────────────
// Tests the window where convertHistoryAsync completes SUCCESSFULLY (returns
// ChatMessage[]) but the .then() callback fires AFTER a session switch has
// already changed the active session. Without a generation guard in .then(),
// stale messages from the first session overwrite the second session's state.
//
// This is distinct from the mid-conversion abort tests in
// async-history-conversion.test.ts, which cover convertHistoryAsync returning
// null when replayGeneration changes during chunked conversion.

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

describe("Race: session_switched history .then() fires after session switch", () => {
	it("two rapid session_switched with history — only second session's messages present", async () => {
		// SMALL history (< chunk size) so convertHistoryAsync completes in one
		// tick without yielding — the .then() callback is the only guard.
		const firstHistory: HistoryMessage[] = [
			makeHistoryMessage("f1", "user", "first session question"),
			makeHistoryMessage("f2", "assistant", "first session answer"),
		];
		const secondHistory: HistoryMessage[] = [
			makeHistoryMessage("s1", "user", "second session question"),
			makeHistoryMessage("s2", "assistant", "second session answer"),
		];

		// First session_switched fires convertHistoryAsync — schedules .then()
		handleMessage({
			type: "session_switched",
			id: "session-first",
			history: { messages: firstHistory, hasMore: true },
		});

		// Second session_switched arrives IMMEDIATELY — clearMessages() bumps
		// replayGeneration, then fires its own convertHistoryAsync
		handleMessage({
			type: "session_switched",
			id: "session-second",
			history: { messages: secondHistory, hasMore: false },
		});

		// Let all microtasks and timers resolve
		await vi.runAllTimersAsync();

		// CRITICAL: Only the second session's messages should be present.
		// Without the generation guard, the first .then() would also
		// prependMessages, contaminating state with stale data.
		expect(sessionState.currentId).toBe("session-second");

		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe(
			"second session question",
		);

		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(1);

		// historyState should reflect the second session's values, not the first
		expect(historyState.hasMore).toBe(false);
		expect(historyState.messageCount).toBe(2);
	});

	it("three rapid session_switched — only the last session wins", async () => {
		handleMessage({
			type: "session_switched",
			id: "s-a",
			history: {
				messages: [makeHistoryMessage("a1", "user", "from A")],
				hasMore: true,
			},
		});
		handleMessage({
			type: "session_switched",
			id: "s-b",
			history: {
				messages: [makeHistoryMessage("b1", "user", "from B")],
				hasMore: true,
			},
		});
		handleMessage({
			type: "session_switched",
			id: "s-c",
			history: {
				messages: [makeHistoryMessage("c1", "user", "from C")],
				hasMore: false,
			},
		});

		await vi.runAllTimersAsync();

		expect(sessionState.currentId).toBe("s-c");
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("from C");
		expect(historyState.hasMore).toBe(false);
	});
});

describe("Race: history_page .then() fires after session switch", () => {
	it("history_page completes after session switch — stale page discarded", async () => {
		// Start with session A
		handleMessage({ type: "session_switched", id: "session-a" });
		await vi.runAllTimersAsync();

		// Request older history for session A
		historyState.loading = true;
		handleMessage({
			type: "history_page",
			sessionId: "session-a",
			messages: [
				makeHistoryMessage("old1", "user", "old question from A"),
				makeHistoryMessage("old2", "assistant", "old answer from A"),
			],
			hasMore: true,
		});

		// Before the history_page .then() fires, switch to session B
		handleMessage({
			type: "session_switched",
			id: "session-b",
			history: {
				messages: [makeHistoryMessage("b1", "user", "from session B")],
				hasMore: false,
			},
		});

		await vi.runAllTimersAsync();

		// CRITICAL: Only session B's messages should be present.
		// The stale history_page for session A must NOT contaminate session B.
		expect(sessionState.currentId).toBe("session-b");

		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("from session B");

		// historyState.loading MUST be false regardless (unconditional reset)
		expect(historyState.loading).toBe(false);

		// historyState should reflect session B's values
		expect(historyState.hasMore).toBe(false);
	});

	it("history_page loading resets even when generation check discards results", async () => {
		// Set up session A
		handleMessage({ type: "session_switched", id: "session-a" });
		await vi.runAllTimersAsync();

		historyState.loading = true;

		// Send history_page then immediately switch session
		handleMessage({
			type: "history_page",
			sessionId: "session-a",
			messages: [makeHistoryMessage("h1", "user", "stale")],
			hasMore: true,
		});

		// Switch away — bumps generation
		handleMessage({ type: "session_switched", id: "session-b" });
		await vi.runAllTimersAsync();

		// loading MUST be false — the .then() must always reset it
		expect(historyState.loading).toBe(false);
	});
});
