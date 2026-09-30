import { seedSessions } from "./session-fixtures.js";
// ─── Regression: Phase No Leak Between Sessions ─────────────────────────────
// Verifies that switching between sessions with different phases does not
// cause phase leaks. When switching from A(streaming) to B(idle) and back
// to A, the phase should reflect A's actual state.

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
	currentChat,
	getOrCreateSessionSlot,
	getSessionPhase,
	handleStatus,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";

beforeEach(() => {
	clearMessages();
	sessionState.currentId = "session-a";
	// Register sessions
	seedSessions([
		...sessionState.sessions.values(),
		...["session-a", "session-b"].map((id) => ({
			id,
			title: "",
			status: "idle" as const,
		})),
	]);
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

describe("Phase does not leak between sessions", () => {
	it("status:idle clears the global phase for the dispatched session", () => {
		const slotA = getOrCreateSessionSlot("session-a");

		slotA.activity.phase = "processing";

		// Send idle to A
		handleStatus(slotA.activity, slotA.messages, {
			type: "status",
			sessionId: "session-a",
			status: "idle",
		});

		// Global phase should be idle
		expect(chatState.phase).toBe("idle");
	});

	it("getSessionPhase returns idle for non-existent sessions", () => {
		expect(getSessionPhase("nonexistent")).toBe("idle");
	});

	it("currentChat reflects the active session's phase", () => {
		const slotA = getOrCreateSessionSlot("session-a");
		slotA.activity.phase = "streaming";

		sessionState.currentId = "session-a";
		// currentChat() composes activity + messages for the current session
		expect(currentChat().phase).toBe("streaming");
	});
});
