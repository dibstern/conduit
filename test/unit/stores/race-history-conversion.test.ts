import { routerState } from "../../../src/lib/frontend/stores/router.svelte.js";
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
import {
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
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
	clearSessionState();
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Race: history_page .then() fires after session switch", () => {
	it("history_page completes after session switch — stale page discarded", async () => {
		// Start with session A
		routerState.path = "/s/session-a";
		handleMessage({
			type: "session_switched",
			id: "session-a",
			sessionId: "session-a",
		});
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
		routerState.path = "/s/session-b";
		handleMessage({
			type: "session_switched",
			id: "session-b",
			sessionId: "session-b",
		});

		await vi.runAllTimersAsync();

		// CRITICAL: Only session B's messages should be present.
		// The stale history_page for session A must NOT contaminate session B.
		expect(sessionState.currentId).toBe("session-b");

		expect(chatState.messages).toHaveLength(0);

		// historyState.loading MUST be false regardless (unconditional reset)
		expect(historyState.loading).toBe(false);

		// historyState should reflect session B's values
		expect(historyState.hasMore).toBe(false);
	});

	it("history_page loading resets even when generation check discards results", async () => {
		// Set up session A
		routerState.path = "/s/session-a";
		handleMessage({
			type: "session_switched",
			id: "session-a",
			sessionId: "session-a",
		});
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
		routerState.path = "/s/session-b";
		handleMessage({
			type: "session_switched",
			id: "session-b",
			sessionId: "session-b",
		});
		await vi.runAllTimersAsync();

		// loading MUST be false — the .then() must always reset it
		expect(historyState.loading).toBe(false);
	});
});
