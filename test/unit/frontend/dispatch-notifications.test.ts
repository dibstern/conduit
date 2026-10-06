import { seedSessions } from "../stores/session-fixtures.js";
// Verifies that handleMessage() calls triggerNotifications() for exactly the
// notification-worthy message types: done and error. (Approvals alert from the
// approvals subscription, stores/approvals.ts.) This test catches wiring bugs
// where the triggerNotifications call is accidentally removed from a switch
// branch in ws-dispatch.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

const { triggerNotificationsMock } = vi.hoisted(() => {
	const triggerNotificationsMock = vi.fn();

	// WebSocket mock needed by ws.svelte.ts
	class MockWebSocket {
		static readonly OPEN = 1;
		static readonly CLOSED = 3;
		readyState = MockWebSocket.OPEN;
		private listeners: Record<string, Array<(ev?: unknown) => void>> = {};
		send(_data: string): void {}
		addEventListener(event: string, fn: (ev?: unknown) => void): void {
			const listeners = (this.listeners[event] ??= []);
			listeners.push(fn);
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

	return { triggerNotificationsMock };
});

// Mock the notification module to spy on triggerNotifications
vi.mock("../../../src/lib/frontend/stores/ws-notifications.js", () => ({
	triggerNotifications: triggerNotificationsMock,
	setPushActive: vi.fn(),
	isPushActive: vi.fn(() => false),
	NOTIF_TYPES: new Set(["done", "error"]),
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
}));

import { applyAlert } from "../../../src/lib/frontend/stores/alerts.js";
import {
	clearMessages,
	getOrCreateSessionActivity,
	isProcessing,
	isStreaming,
	phaseToStreaming,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { showToast } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";

beforeEach(() => {
	sessionState.currentId = "test-session";
	// Register sessions used in test events so routePerSession's
	// unknown-session guard doesn't drop them.
	seedSessions([
		{ id: "test-session", title: "", status: "idle" },
		{ id: "s1", title: "", status: "idle" },
	]);
	clearMessages();
	triggerNotificationsMock.mockClear();
	vi.mocked(showToast).mockClear();
});

afterEach(() => {
	clearMessages();
});

describe("handleMessage calls triggerNotifications for notification-worthy types", () => {
	it("calls triggerNotifications for 'done' messages", () => {
		const msg: RelayMessage = {
			type: "done",
			sessionId: "test-session",
			code: 0,
		};
		handleMessage(msg);
		expect(triggerNotificationsMock).toHaveBeenCalledOnce();
		expect(triggerNotificationsMock).toHaveBeenCalledWith(msg);
	});

	it("calls triggerNotifications for 'error' messages", () => {
		const msg: RelayMessage = {
			type: "error",
			sessionId: "test-session",
			message: "test error",
			code: "UNKNOWN",
		};
		handleMessage(msg);
		expect(triggerNotificationsMock).toHaveBeenCalledOnce();
		expect(triggerNotificationsMock).toHaveBeenCalledWith(msg);
	});
});

describe("applyAlert fires the ding for a session no tab is viewing", () => {
	it("calls triggerNotifications with a synthetic done message", () => {
		applyAlert({ _tag: "alert", kind: "done", alertId: "a1" });
		expect(triggerNotificationsMock).toHaveBeenCalledOnce();
		expect(triggerNotificationsMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "done", alertId: "a1" }),
		);
	});

	it("calls triggerNotifications and toasts for an error", () => {
		applyAlert({
			_tag: "alert",
			kind: "error",
			alertId: "a2",
			message: "Something failed",
		});
		expect(triggerNotificationsMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "error", message: "Something failed" }),
		);
		expect(showToast).toHaveBeenCalledOnce();
	});

	it("threads sessionId and alertId to triggerNotifications", () => {
		applyAlert({
			_tag: "alert",
			kind: "done",
			sessionId: "sess-xyz",
			alertId: "turn-1:done",
		});
		expect(triggerNotificationsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "done",
				sessionId: "sess-xyz",
				alertId: "turn-1:done",
			}),
		);
	});

	it("does NOT update chat state (only triggers notification)", () => {
		phaseToStreaming(getOrCreateSessionActivity("test-session"));

		applyAlert({
			_tag: "alert",
			kind: "done",
			sessionId: "test-session",
			alertId: "a3",
		});

		expect(isProcessing()).toBe(true);
		expect(isStreaming()).toBe(true);
	});
});

describe("handleMessage does NOT call triggerNotifications for other types", () => {
	it("does not call triggerNotifications for 'delta'", () => {
		handleMessage({
			type: "delta",
			sessionId: "test-session",
			text: "hello",
		} as RelayMessage);
		expect(triggerNotificationsMock).not.toHaveBeenCalled();
	});

	it("does not call triggerNotifications for 'tool_start'", () => {
		handleMessage({
			type: "tool_start",
			sessionId: "test-session",
			id: "t1",
			name: "bash",
		} as RelayMessage);
		expect(triggerNotificationsMock).not.toHaveBeenCalled();
	});

	it("does not call triggerNotifications for 'tool_result'", () => {
		handleMessage({
			type: "tool_result",
			sessionId: "test-session",
			id: "t1",
			content: "output",
			is_error: false,
		} as RelayMessage);
		expect(triggerNotificationsMock).not.toHaveBeenCalled();
	});

	it("does not call triggerNotifications for 'result'", () => {
		handleMessage({
			type: "result",
			usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
			cost: 0,
			duration: 100,
			sessionId: "s1",
		} as RelayMessage);
		expect(triggerNotificationsMock).not.toHaveBeenCalled();
	});
});
