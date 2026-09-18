// ─── Session Chat State Routing Tests ────────────────────────────────────────
// Verifies that routePerSession dispatches per-session events to the correct
// session slot by event.sessionId, without cross-contaminating other slots.
//
// Key scenario: Dispatch delta for session B while currentId=A.
// Assert B's slot mutates, A's slot is untouched.

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
	chatState,
	clearMessages,
	getOrCreateSessionSlot,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	applySessionUpsert,
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	sessionState.currentId = "session-a";
	// Register all sessions used in tests.
	for (const id of ["session-a", "session-b", "session-c"]) {
		applySessionUpsert({ id, title: "", status: "idle" });
	}
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	clearMessages();
	sessionActivity.clear();
	sessionMessages.clear();
	clearSessionState();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Per-session routing: delta for B while currentId=A", () => {
	it("dispatches delta to session B's slot, not session A's slot", () => {
		// Pre-create slot for A so we can verify it's untouched
		const slotA = getOrCreateSessionSlot("session-a");
		const slotAMessagesBefore = slotA.messages.messages.length;

		// Send a delta to session B
		handleMessage({
			type: "delta",
			sessionId: "session-b",
			text: "Hello from B",
		} as RelayMessage);

		// Session B should have a slot created by routePerSession, and the delta
		// must land there — not in the on-screen view, which is session A.
		expect(
			sessionMessages.get("session-b")?.messages.length ?? 0,
		).toBeGreaterThan(0);
		expect(chatState.messages).toHaveLength(0);

		// Session A's slot should be untouched
		expect(slotA.messages.messages.length).toBe(slotAMessagesBefore);
	});

	it("routes status event to the correct session slot", () => {
		// Create session A's slot with a streaming phase
		const slotA = getOrCreateSessionSlot("session-a");
		slotA.activity.phase = "streaming";

		// Send status:idle to session B — should NOT affect A's phase
		handleMessage({
			type: "status",
			sessionId: "session-b",
			status: "idle",
		} as RelayMessage);

		// A's phase should still be streaming (untouched)
		expect(slotA.activity.phase).toBe("streaming");
	});

	it("routes done event to the correct session", () => {
		const slotA = getOrCreateSessionSlot("session-a");
		slotA.activity.phase = "streaming";

		// Start streaming on B
		handleMessage({
			type: "delta",
			sessionId: "session-b",
			text: "streaming on B",
		} as RelayMessage);
		const slotB = getOrCreateSessionSlot("session-b");
		expect(slotB.activity.phase).toBe("streaming");

		// Done on B
		handleMessage({
			type: "done",
			sessionId: "session-b",
			code: 0,
		} as RelayMessage);

		// B's own slot ends the turn: idle, one more epoch, assistant committed.
		expect(slotB.activity.phase).toBe("idle");
		expect(slotB.activity.turnEpoch).toBe(1);
		expect(slotB.messages.currentAssistantText).toBe("");
		expect(slotB.messages.messages.at(-1)?.type).toBe("assistant");

		// A is on screen and untouched — done for B never reaches the mirror.
		expect(slotA.activity.phase).toBe("streaming");
		expect(slotA.activity.turnEpoch).toBe(0);
		expect(chatState.phase).toBe("streaming");
		expect(chatState.messages).toHaveLength(0);
	});
});
