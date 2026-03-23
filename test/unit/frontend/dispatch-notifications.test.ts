// ─── handleMessage → triggerNotifications wiring ─────────────────────────────
// Verifies that handleMessage() calls triggerNotifications() for exactly the
// four notification-worthy message types: done, error, permission_request,
// ask_user. This test catches wiring bugs where the triggerNotifications call
// is accidentally removed from a switch branch in ws-dispatch.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

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

	return { triggerNotificationsMock };
});

// Mock the notification module to spy on triggerNotifications
vi.mock("../../../src/lib/frontend/stores/ws-notifications.js", () => ({
	triggerNotifications: triggerNotificationsMock,
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
}));

import {
	chatState,
	clearMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	triggerNotificationsMock.mockClear();
});

afterEach(() => {
	clearMessages();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("handleMessage calls triggerNotifications for notification-worthy types", () => {
	it("calls triggerNotifications for 'done' messages", () => {
		const msg: RelayMessage = { type: "done" } as RelayMessage;
		handleMessage(msg);
		expect(triggerNotificationsMock).toHaveBeenCalledOnce();
		expect(triggerNotificationsMock).toHaveBeenCalledWith(msg);
	});

	it("calls triggerNotifications for 'error' messages", () => {
		const msg: RelayMessage = {
			type: "error",
			message: "test error",
			code: "UNKNOWN",
		} as RelayMessage;
		handleMessage(msg);
		expect(triggerNotificationsMock).toHaveBeenCalledOnce();
		expect(triggerNotificationsMock).toHaveBeenCalledWith(msg);
	});

	it("calls triggerNotifications for 'permission_request' messages", () => {
		const msg: RelayMessage = {
			type: "permission_request",
			toolName: "bash",
			requestId: "req-1",
		} as RelayMessage;
		handleMessage(msg);
		expect(triggerNotificationsMock).toHaveBeenCalledOnce();
		expect(triggerNotificationsMock).toHaveBeenCalledWith(msg);
	});

	it("calls triggerNotifications for 'ask_user' messages", () => {
		const msg: RelayMessage = {
			type: "ask_user",
			toolId: "q-1",
			questions: [{ question: "What?", header: "" }],
		} as RelayMessage;
		handleMessage(msg);
		expect(triggerNotificationsMock).toHaveBeenCalledOnce();
		expect(triggerNotificationsMock).toHaveBeenCalledWith(msg);
	});
});

describe("handleMessage calls triggerNotifications for notification_event (cross-session)", () => {
	it("calls triggerNotifications with synthetic done message for notification_event", () => {
		handleMessage({
			type: "notification_event",
			eventType: "done",
		});
		expect(triggerNotificationsMock).toHaveBeenCalledOnce();
		expect(triggerNotificationsMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "done" }),
		);
	});

	it("calls triggerNotifications with synthetic error message for notification_event", () => {
		handleMessage({
			type: "notification_event",
			eventType: "error",
			message: "Something failed",
		});
		expect(triggerNotificationsMock).toHaveBeenCalledOnce();
		expect(triggerNotificationsMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "error", message: "Something failed" }),
		);
	});

	it("threads sessionId from notification_event to triggerNotifications", () => {
		handleMessage({
			type: "notification_event",
			eventType: "done",
			sessionId: "sess-xyz",
		});
		expect(triggerNotificationsMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "done", sessionId: "sess-xyz" }),
		);
	});

	it("does NOT update chat state for notification_event (only triggers notification)", () => {
		chatState.processing = true;
		chatState.streaming = true;

		handleMessage({
			type: "notification_event",
			eventType: "done",
		});

		// Chat state should be unchanged — notification_event doesn't call handleDone
		expect(chatState.processing).toBe(true);
		expect(chatState.streaming).toBe(true);
	});
});

describe("handleMessage does NOT call triggerNotifications for other types", () => {
	it("does not call triggerNotifications for 'delta'", () => {
		handleMessage({ type: "delta", text: "hello" } as RelayMessage);
		expect(triggerNotificationsMock).not.toHaveBeenCalled();
	});

	it("does not call triggerNotifications for 'status'", () => {
		handleMessage({
			type: "status",
			status: "processing",
		} as RelayMessage);
		expect(triggerNotificationsMock).not.toHaveBeenCalled();
	});

	it("does not call triggerNotifications for 'tool_start'", () => {
		handleMessage({
			type: "tool_start",
			id: "t1",
			name: "bash",
		} as RelayMessage);
		expect(triggerNotificationsMock).not.toHaveBeenCalled();
	});

	it("does not call triggerNotifications for 'tool_result'", () => {
		handleMessage({
			type: "tool_result",
			id: "t1",
			content: "output",
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
