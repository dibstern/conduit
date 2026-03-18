// ─── Service Worker Push Handler Tests ───────────────────────────────────────
// Tests the push event handler in sw.ts: notification display, tag assignment,
// requireInteraction behavior, and (critically) that NO visibility suppression
// occurs — push notifications always show regardless of client visibility.
//
// Bug #3 root cause: The SW previously checked client.focused/visibilityState
// and suppressed "done" notifications when any tab was visible. Since browser
// Notification API notifications are already suppressed when push is active
// (_pushActive flag in ws-notifications.ts), this created a dead zone where
// NEITHER notification path fired.
//
// These tests directly exercise the push event listener registered in sw.ts
// by importing the module into a simulated ServiceWorkerGlobalScope.
//
// NOTE: The push listener uses `self.registration.showNotification(...)` at
// call time. To avoid test pollution from other test files that may modify
// `globalThis.self`, we read `self.registration.showNotification` AFTER
// calling the listener (via the promise passed to `event.waitUntil`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── ServiceWorkerGlobalScope simulation ────────────────────────────────────
// sw.ts calls self.addEventListener("push", ...) at module level.
// We capture the listener by stubbing self before importing.

type PushListener = (event: unknown) => void;
type EventHandler = (...args: never[]) => unknown;

let pushListener: PushListener | null = null;
let showNotificationMock: ReturnType<typeof vi.fn>;

/** Call pushListener, throwing if not registered (avoids non-null assertions). */
function callPushListener(event: unknown): void {
	if (!pushListener) throw new Error("push listener not registered");
	pushListener(event);
}

function createPushEvent(data: unknown) {
	const waitUntilPromises: Promise<unknown>[] = [];
	return {
		data: {
			json: () => data,
		},
		waitUntil: vi.fn((p: Promise<unknown>) => {
			waitUntilPromises.push(p);
		}),
		_waitUntilPromises: waitUntilPromises,
	};
}

function createPushEventWithBadData() {
	return {
		data: {
			json: () => {
				throw new Error("bad json");
			},
		},
		waitUntil: vi.fn(),
	};
}

/**
 * Retrieve the showNotification mock from the current `globalThis.self`.
 * This resolves the mock at runtime (same as the SW push listener does),
 * avoiding issues when other test files modify `globalThis.self` between
 * our beforeEach and test execution.
 */
function getShowNotificationSpy(): ReturnType<typeof vi.fn> {
	const s = globalThis.self as unknown as {
		registration?: { showNotification?: ReturnType<typeof vi.fn> };
	};
	return s?.registration?.showNotification ?? showNotificationMock;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(async () => {
	vi.resetModules();
	pushListener = null;

	showNotificationMock = vi.fn().mockResolvedValue(undefined);

	// Simulate ServiceWorkerGlobalScope
	const listeners: Record<string, EventHandler[]> = {};
	const swSelf = {
		addEventListener: vi.fn((type: string, handler: EventHandler) => {
			(listeners[type] ??= []).push(handler);
			if (type === "push") pushListener = handler as PushListener;
		}),
		skipWaiting: vi.fn().mockResolvedValue(undefined),
		clients: {
			claim: vi.fn().mockResolvedValue(undefined),
			matchAll: vi.fn().mockResolvedValue([]),
			openWindow: vi.fn(),
		},
		registration: {
			showNotification: showNotificationMock,
			scope: "/",
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

	// Import sw.ts — this registers the push listener on self
	await import("../../../src/lib/frontend/sw.js");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SW push handler", () => {
	it("registers a push event listener", () => {
		expect(pushListener).toBeTypeOf("function");
	});

	// ─── Core: always shows notification (no visibility suppression) ────

	it("shows notification for 'done' event", () => {
		const event = createPushEvent({
			type: "done",
			title: "Task Complete",
			body: "Agent has finished processing.",
			tag: "opencode-done",
		});

		callPushListener(event);

		const spy = getShowNotificationSpy();
		expect(spy).toHaveBeenCalledWith("Task Complete", {
			body: "Agent has finished processing.",
			tag: "opencode-done",
			data: expect.objectContaining({ type: "done" }),
		});
	});

	it("shows notification for 'error' event with requireInteraction", () => {
		const event = createPushEvent({
			type: "error",
			title: "Error",
			body: "Something broke",
		});

		callPushListener(event);

		const spy = getShowNotificationSpy();
		expect(spy).toHaveBeenCalledWith("Error", {
			body: "Something broke",
			tag: "opencode-error",
			data: expect.objectContaining({ type: "error" }),
			requireInteraction: true,
		});
	});

	it("shows notification for 'permission_request' with requireInteraction", () => {
		const event = createPushEvent({
			type: "permission_request",
			title: "Permission Needed",
			body: "bash needs approval",
			requestId: "req-42",
		});

		callPushListener(event);

		const spy = getShowNotificationSpy();
		expect(spy).toHaveBeenCalledWith("Permission Needed", {
			body: "bash needs approval",
			tag: "perm-req-42",
			data: expect.objectContaining({ type: "permission_request" }),
			requireInteraction: true,
		});
	});

	// ─── Regression: NO visibility suppression ─────────────────────────
	// This is the critical Bug #3 regression test. The old code suppressed
	// "done" notifications when any client was visible. The fix removes
	// this check entirely — the SW always shows notifications.

	it("shows 'done' notification without checking client visibility", () => {
		const event = createPushEvent({
			type: "done",
			title: "Task Complete",
			body: "Agent has finished processing.",
			tag: "opencode-done",
		});

		callPushListener(event);

		const spy = getShowNotificationSpy();
		expect(spy).toHaveBeenCalledOnce();
		// matchAll should NOT be called (visibility check removed)
		const s = globalThis.self as unknown as {
			clients: { matchAll: ReturnType<typeof vi.fn> };
		};
		expect(s.clients.matchAll).not.toHaveBeenCalled();
	});

	// ─── Silent test push ──────────────────────────────────────────────

	it("does NOT show notification for type=test (silent validation)", () => {
		const event = createPushEvent({ type: "test" });

		callPushListener(event);

		const spy = getShowNotificationSpy();
		expect(spy).not.toHaveBeenCalled();
		expect(event.waitUntil).not.toHaveBeenCalled();
	});

	// ─── Bad data handling ─────────────────────────────────────────────

	it("silently returns on invalid JSON data", () => {
		const event = createPushEventWithBadData();

		callPushListener(event);

		const spy = getShowNotificationSpy();
		expect(spy).not.toHaveBeenCalled();
	});

	// ─── Fallback title ────────────────────────────────────────────────

	it("uses fallback title when payload has no title", () => {
		const event = createPushEvent({ type: "done", body: "Done!" });

		callPushListener(event);

		const spy = getShowNotificationSpy();
		expect(spy).toHaveBeenCalledWith(
			"OpenCode Relay",
			expect.objectContaining({ body: "Done!" }),
		);
	});

	// ─── Tag assignment ────────────────────────────────────────────────

	it("uses payload tag for done events when provided", () => {
		const event = createPushEvent({
			type: "done",
			title: "Done",
			tag: "custom-tag-123",
		});

		callPushListener(event);

		const spy = getShowNotificationSpy();
		expect(spy).toHaveBeenCalledWith(
			"Done",
			expect.objectContaining({ tag: "custom-tag-123" }),
		);
	});

	it("defaults to opencode-done tag for done events without tag", () => {
		const event = createPushEvent({ type: "done", title: "Done" });

		callPushListener(event);

		const spy = getShowNotificationSpy();
		expect(spy).toHaveBeenCalledWith(
			"Done",
			expect.objectContaining({ tag: "opencode-done" }),
		);
	});

	it("uses perm-unknown tag for permission_request without requestId", () => {
		const event = createPushEvent({
			type: "permission_request",
			title: "Permission",
		});

		callPushListener(event);

		const spy = getShowNotificationSpy();
		expect(spy).toHaveBeenCalledWith(
			"Permission",
			expect.objectContaining({ tag: "perm-unknown" }),
		);
	});

	// ─── waitUntil ─────────────────────────────────────────────────────

	it("passes showNotification promise to event.waitUntil", () => {
		const event = createPushEvent({
			type: "done",
			title: "Done",
		});

		callPushListener(event);

		expect(event.waitUntil).toHaveBeenCalledOnce();
	});

	// ─── showNotification failure is caught ────────────────────────────

	it("catches showNotification errors without throwing", async () => {
		showNotificationMock.mockRejectedValue(new Error("notification failed"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const event = createPushEvent({ type: "done", title: "Done" });

		callPushListener(event);

		// Wait for the promise chain to resolve
		await vi.waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith(
				"[sw] Failed to show notification:",
				expect.any(Error),
			);
		});

		warnSpy.mockRestore();
	});
});
