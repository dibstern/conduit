// ─── Service Worker Notification Click Handler Tests ─────────────────────────
// Tests the notificationclick event handler in sw.ts: URL construction from
// notification data (slug/sessionId), client matching priority (exact URL →
// project prefix → visible → any → openWindow), and postMessage dispatch
// with navigate_to_session payloads.
//
// These tests directly exercise the notificationclick listener registered in
// sw.ts by importing the module into a simulated ServiceWorkerGlobalScope.
//
// Setup mirrors sw-push.test.ts — we capture the listener by stubbing self
// before importing the module.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── ServiceWorkerGlobalScope simulation ────────────────────────────────────
// sw.ts calls self.addEventListener("notificationclick", ...) at module level.
// We capture the listener by stubbing self before importing.

type NotificationClickListener = (event: unknown) => void;
type EventHandler = (...args: never[]) => unknown;

let notificationClickListener: NotificationClickListener | null = null;
let openWindowMock: ReturnType<typeof vi.fn>;
let matchAllMock: ReturnType<typeof vi.fn>;

/** Call notificationClickListener, throwing if not registered. */
function callNotificationClickListener(event: unknown): void {
	if (!notificationClickListener)
		throw new Error("notificationclick listener not registered");
	notificationClickListener(event);
}

function createNotificationEvent(data: Record<string, unknown>) {
	const waitUntilPromises: Promise<unknown>[] = [];
	return {
		notification: { data, close: vi.fn() },
		waitUntil: vi.fn((p: Promise<unknown>) => {
			waitUntilPromises.push(p);
		}),
		_waitUntilPromises: waitUntilPromises,
	};
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(async () => {
	vi.resetModules();
	notificationClickListener = null;

	openWindowMock = vi.fn().mockResolvedValue(undefined);
	matchAllMock = vi.fn().mockResolvedValue([]);

	// Simulate ServiceWorkerGlobalScope
	const listeners: Record<string, EventHandler[]> = {};
	const swSelf = {
		addEventListener: vi.fn((type: string, handler: EventHandler) => {
			(listeners[type] ??= []).push(handler);
			if (type === "notificationclick")
				notificationClickListener = handler as NotificationClickListener;
		}),
		skipWaiting: vi.fn().mockResolvedValue(undefined),
		clients: {
			claim: vi.fn().mockResolvedValue(undefined),
			matchAll: matchAllMock,
			openWindow: openWindowMock,
		},
		registration: {
			showNotification: vi.fn().mockResolvedValue(undefined),
			scope: "http://localhost:2633/",
		},
		location: { origin: "http://localhost:2633" },
	};

	vi.stubGlobal("self", swSelf);

	// Provide caches API stub (sw.ts activate handler cleans up old caches)
	vi.stubGlobal("caches", {
		open: vi.fn().mockResolvedValue({
			put: vi.fn(),
		}),
		keys: vi.fn().mockResolvedValue([]),
		match: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn(),
	});

	// Import sw.ts — this registers the notificationclick listener on self
	await import("../../../src/lib/frontend/sw.js");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SW notificationclick handler", () => {
	it("registers a notificationclick listener", () => {
		expect(notificationClickListener).toBeTypeOf("function");
	});

	// ─── URL construction ──────────────────────────────────────────────

	describe("URL construction", () => {
		it("uses data.url when provided", async () => {
			const event = createNotificationEvent({
				url: "http://localhost:2633/custom/path",
			});
			matchAllMock.mockResolvedValue([]);

			callNotificationClickListener(event);
			await Promise.all(event._waitUntilPromises);

			expect(openWindowMock).toHaveBeenCalledWith(
				"http://localhost:2633/custom/path",
			);
		});

		it("constructs /p/<slug>/s/<sessionId> when both provided", async () => {
			const event = createNotificationEvent({
				slug: "my-project",
				sessionId: "sess-123",
			});
			matchAllMock.mockResolvedValue([]);

			callNotificationClickListener(event);
			await Promise.all(event._waitUntilPromises);

			expect(openWindowMock).toHaveBeenCalledWith(
				"http://localhost:2633/p/my-project/s/sess-123",
			);
		});

		it("constructs /p/<slug>/ when only slug provided", async () => {
			const event = createNotificationEvent({
				slug: "my-project",
			});
			matchAllMock.mockResolvedValue([]);

			callNotificationClickListener(event);
			await Promise.all(event._waitUntilPromises);

			expect(openWindowMock).toHaveBeenCalledWith(
				"http://localhost:2633/p/my-project/",
			);
		});

		it("falls back to baseUrl when neither provided", async () => {
			const event = createNotificationEvent({});
			matchAllMock.mockResolvedValue([]);

			callNotificationClickListener(event);
			await Promise.all(event._waitUntilPromises);

			expect(openWindowMock).toHaveBeenCalledWith("http://localhost:2633/");
		});
	});

	// ─── Client matching ───────────────────────────────────────────────

	describe("client matching", () => {
		it("focuses client already on exact URL", async () => {
			const mockClient = {
				url: "http://localhost:2633/p/my-project/s/sess-123",
				visibilityState: "visible",
				focus: vi.fn().mockResolvedValue(undefined),
				postMessage: vi.fn(),
			};
			matchAllMock.mockResolvedValue([mockClient]);

			const event = createNotificationEvent({
				slug: "my-project",
				sessionId: "sess-123",
			});

			callNotificationClickListener(event);
			await Promise.all(event._waitUntilPromises);

			expect(mockClient.focus).toHaveBeenCalledOnce();
			expect(mockClient.postMessage).not.toHaveBeenCalled();
			expect(openWindowMock).not.toHaveBeenCalled();
		});

		it("posts navigate_to_session to client on same project", async () => {
			const mockClient = {
				url: "http://localhost:2633/p/my-project/s/other-session",
				visibilityState: "visible",
				focus: vi.fn().mockResolvedValue(undefined),
				postMessage: vi.fn(),
			};
			matchAllMock.mockResolvedValue([mockClient]);

			const event = createNotificationEvent({
				slug: "my-project",
				sessionId: "sess-123",
			});

			callNotificationClickListener(event);
			await Promise.all(event._waitUntilPromises);

			expect(mockClient.focus).toHaveBeenCalledOnce();
			expect(mockClient.postMessage).toHaveBeenCalledWith({
				type: "navigate_to_session",
				sessionId: "sess-123",
				slug: "my-project",
				url: "http://localhost:2633/p/my-project/s/sess-123",
			});
			expect(openWindowMock).not.toHaveBeenCalled();
		});

		it("posts navigate_to_session with slug to any visible client", async () => {
			const mockClient = {
				url: "http://localhost:2633/p/other-project/s/other-session",
				visibilityState: "visible",
				focus: vi.fn().mockResolvedValue(undefined),
				postMessage: vi.fn(),
			};
			matchAllMock.mockResolvedValue([mockClient]);

			const event = createNotificationEvent({
				slug: "my-project",
				sessionId: "sess-123",
			});

			callNotificationClickListener(event);
			await Promise.all(event._waitUntilPromises);

			expect(mockClient.focus).toHaveBeenCalledOnce();
			expect(mockClient.postMessage).toHaveBeenCalledWith({
				type: "navigate_to_session",
				sessionId: "sess-123",
				slug: "my-project",
				url: "http://localhost:2633/p/my-project/s/sess-123",
			});
		});

		it("opens new window when no clients exist", async () => {
			matchAllMock.mockResolvedValue([]);

			const event = createNotificationEvent({
				slug: "my-project",
				sessionId: "sess-123",
			});

			callNotificationClickListener(event);
			await Promise.all(event._waitUntilPromises);

			expect(openWindowMock).toHaveBeenCalledWith(
				"http://localhost:2633/p/my-project/s/sess-123",
			);
		});

		it("includes slug and url in postMessage payload", async () => {
			const mockClient = {
				url: "http://localhost:2633/p/other-project/",
				visibilityState: "visible",
				focus: vi.fn().mockResolvedValue(undefined),
				postMessage: vi.fn(),
			};
			matchAllMock.mockResolvedValue([mockClient]);

			const event = createNotificationEvent({
				slug: "my-project",
				sessionId: "sess-456",
			});

			callNotificationClickListener(event);
			await Promise.all(event._waitUntilPromises);

			expect(mockClient.postMessage).toHaveBeenCalledOnce();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by toHaveBeenCalledOnce
			const payload = mockClient.postMessage.mock.calls[0]![0];
			expect(payload).toEqual({
				type: "navigate_to_session",
				sessionId: "sess-456",
				slug: "my-project",
				url: "http://localhost:2633/p/my-project/s/sess-456",
			});
		});
	});
});
