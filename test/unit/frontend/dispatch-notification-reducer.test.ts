// ─── handleMessage → notification reducer dispatch wiring ────────────────────
// Verifies that handleMessage() dispatches the correct actions to the
// notification reducer for notification_event, session_list, and
// session_switched message types. This test catches wiring bugs where
// dispatch calls are accidentally removed or mis-routed in ws-dispatch.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { dispatchMock } = vi.hoisted(() => {
	const dispatchMock = vi.fn();

	// WebSocket mock needed by ws.svelte.ts
	class MockWebSocket {
		static readonly OPEN = 1;
		static readonly CLOSED = 3;
		readyState = MockWebSocket.OPEN;
		private listeners: Record<string, Array<(ev?: unknown) => void>> = {};
		send(_data: string): void {}
		addEventListener(event: string, fn: (ev?: unknown) => void): void {
			if (!this.listeners[event]) this.listeners[event] = [];
			// biome-ignore lint/style/noNonNullAssertion: safe — initialized above
			this.listeners[event]!.push(fn);
		}
		close(): void {
			this.readyState = MockWebSocket.CLOSED;
		}
	}

	Object.defineProperty(globalThis, "WebSocket", {
		value: MockWebSocket,
		writable: true,
		configurable: true,
	});

	if (typeof globalThis.window === "undefined") {
		Object.defineProperty(globalThis, "window", {
			value: {
				location: { protocol: "http:", host: "localhost:3000", pathname: "/" },
				history: { pushState: () => {}, replaceState: () => {} },
				addEventListener: () => {},
			},
			writable: true,
			configurable: true,
		});
	}

	return { dispatchMock };
});

// Mock the notification reducer to spy on dispatch
vi.mock(
	"../../../src/lib/frontend/stores/notification-reducer.svelte.js",
	async () => {
		const actual = await vi.importActual(
			"../../../src/lib/frontend/stores/notification-reducer.svelte.js",
		);
		return {
			...actual,
			dispatch: dispatchMock,
			getNotifState: vi.fn(() => ({ kind: "none" })),
			getSessionIndicator: vi.fn(() => null),
			getAttentionSessions: vi.fn(() => new Map()),
			resetNotifState: vi.fn(),
		};
	},
);

// Mock ws-notifications to prevent actual notification side effects
vi.mock("../../../src/lib/frontend/stores/ws-notifications.js", () => ({
	triggerNotifications: vi.fn(),
	setPushActive: vi.fn(),
	isPushActive: vi.fn(() => false),
	NOTIF_TYPES: new Set(["done", "error", "permission_request", "ask_user"]),
}));

// Mock DOMPurify (required by chat.svelte.ts → markdown.ts)
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

// Mock ui.svelte.js
vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: vi.fn(),
	showBanner: vi.fn(),
	removeBanner: vi.fn(),
	setClientCount: vi.fn(),
	updateContextPercent: vi.fn(),
}));

import { clearMessages } from "../../../src/lib/frontend/stores/chat.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	dispatchMock.mockClear();
});

afterEach(() => {
	clearMessages();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("notification_event -> notification reducer dispatch", () => {
	it("dispatches question_appeared for ask_user notification_event with sessionId", () => {
		handleMessage({
			type: "notification_event",
			eventType: "ask_user",
			sessionId: "sess-1",
		});
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "question_appeared",
			sessionId: "sess-1",
		});
	});

	it("dispatches question_resolved for ask_user_resolved notification_event with sessionId", () => {
		handleMessage({
			type: "notification_event",
			eventType: "ask_user_resolved",
			sessionId: "sess-2",
		});
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "question_resolved",
			sessionId: "sess-2",
		});
	});

	it("dispatches session_done for done notification_event with sessionId", () => {
		handleMessage({
			type: "notification_event",
			eventType: "done",
			sessionId: "sess-3",
		});
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "session_done",
			sessionId: "sess-3",
		});
	});

	it("does NOT dispatch to reducer when notification_event has no sessionId", () => {
		handleMessage({
			type: "notification_event",
			eventType: "ask_user",
		});
		expect(dispatchMock).not.toHaveBeenCalled();
	});

	it("does NOT dispatch to reducer for unrecognized eventType", () => {
		handleMessage({
			type: "notification_event",
			eventType: "error",
			sessionId: "sess-4",
		});
		expect(dispatchMock).not.toHaveBeenCalled();
	});
});

describe("session_list -> reconcile dispatch", () => {
	it("dispatches reconcile with question counts from session_list", () => {
		handleMessage({
			type: "session_list",
			sessions: [
				{ id: "sess-a", title: "Session A", pendingQuestionCount: 2 },
				{ id: "sess-b", title: "Session B", pendingQuestionCount: 1 },
			],
			roots: true,
		} as RelayMessage);
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "reconcile",
			counts: new Map([
				["sess-a", { questions: 2, permissions: 0 }],
				["sess-b", { questions: 1, permissions: 0 }],
			]),
		});
	});

	it("dispatches reconcile with empty counts when no sessions have pendingQuestionCount", () => {
		handleMessage({
			type: "session_list",
			sessions: [
				{ id: "sess-a", title: "Session A" },
				{ id: "sess-b", title: "Session B" },
			],
			roots: true,
		} as RelayMessage);
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "reconcile",
			counts: new Map(),
		});
	});

	it("skips sessions with pendingQuestionCount of 0", () => {
		handleMessage({
			type: "session_list",
			sessions: [
				{ id: "sess-a", title: "Session A", pendingQuestionCount: 0 },
				{ id: "sess-b", title: "Session B", pendingQuestionCount: 3 },
			],
			roots: true,
		} as RelayMessage);
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "reconcile",
			counts: new Map([["sess-b", { questions: 3, permissions: 0 }]]),
		});
	});
});

describe("session_switched -> session_viewed dispatch", () => {
	it("dispatches session_viewed with the new session ID", () => {
		handleMessage({
			type: "session_switched",
			id: "new-session-id",
		} as RelayMessage);
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "session_viewed",
			sessionId: "new-session-id",
		});
	});
});
