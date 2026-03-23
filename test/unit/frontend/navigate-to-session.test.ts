// ─── SW navigation listener + session navigation callback tests ─────────────
// Tests initSWNavigationListener(), onNavigateToSession(), and
// clearNavigateToSession() from ws-notifications.ts.
//
// These functions wire push notification clicks (posted by the SW as
// `navigate_to_session` messages) to the registered navigation callback.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Module mocks (must be declared before importing ws-notifications) ──────

const getCurrentSlugMock = vi.fn(() => "test-project");
const navigateMock = vi.fn();

vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: getCurrentSlugMock,
	navigate: navigateMock,
	getCurrentRoute: vi.fn(() => ({ page: "chat", slug: "test-project" })),
	getCurrentSessionId: vi.fn(() => null),
	routerState: { path: "/p/test-project/" },
	slugState: { current: "test-project" },
	syncSlugState: vi.fn(),
	replaceRoute: vi.fn(),
	getSessionHref: vi.fn(),
	getTransitionLog: vi.fn(() => []),
	clearTransitionLog: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/utils/sound.js", () => ({
	playDoneSound: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/utils/notif-settings.js", () => ({
	getNotifSettings: vi.fn(() => ({
		browser: false,
		sound: false,
		push: false,
	})),
}));

vi.mock("../../../src/lib/notification-content.js", () => ({
	notificationContent: vi.fn(() => null),
}));

// ─── navigator.serviceWorker mock ───────────────────────────────────────────

let messageListeners: Array<(event: unknown) => void> = [];
const addEventListenerMock = vi.fn(
	(type: string, fn: (event: unknown) => void) => {
		if (type === "message") messageListeners.push(fn);
	},
);

vi.stubGlobal("navigator", {
	serviceWorker: {
		addEventListener: addEventListenerMock,
	},
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Simulate the SW posting a message to the client. */
function postSWMessage(data: Record<string, unknown>): void {
	for (const fn of messageListeners) {
		fn({ data });
	}
}

type WSNotificationsModule =
	typeof import("../../../src/lib/frontend/stores/ws-notifications.js");

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
	vi.resetModules();
	messageListeners = [];
	addEventListenerMock.mockClear();
	getCurrentSlugMock.mockReturnValue("test-project");
	navigateMock.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SW navigation listener", () => {
	it("registers a message listener on navigator.serviceWorker", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		mod.initSWNavigationListener();

		expect(addEventListenerMock).toHaveBeenCalledWith(
			"message",
			expect.any(Function),
		);
	});

	it("only registers once even if called multiple times", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		mod.initSWNavigationListener();
		mod.initSWNavigationListener();
		mod.initSWNavigationListener();

		expect(addEventListenerMock).toHaveBeenCalledTimes(1);
	});

	it("calls registered callback when SW posts navigate_to_session", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		const callback = vi.fn();
		mod.onNavigateToSession(callback);
		mod.initSWNavigationListener();

		postSWMessage({
			type: "navigate_to_session",
			sessionId: "sess-123",
			slug: "test-project",
		});

		expect(callback).toHaveBeenCalledWith("sess-123");
	});

	it("does not call callback when sessionId is missing", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		const callback = vi.fn();
		mod.onNavigateToSession(callback);
		mod.initSWNavigationListener();

		postSWMessage({
			type: "navigate_to_session",
		});

		expect(callback).not.toHaveBeenCalled();
	});

	it("navigates via URL when slug differs from current project", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		const callback = vi.fn();
		mod.onNavigateToSession(callback);
		mod.initSWNavigationListener();

		// Current slug is "test-project", incoming is "other-project"
		getCurrentSlugMock.mockReturnValue("test-project");

		postSWMessage({
			type: "navigate_to_session",
			sessionId: "sess-456",
			slug: "other-project",
			url: "/p/other-project/s/sess-456",
		});

		expect(navigateMock).toHaveBeenCalledWith("/p/other-project/s/sess-456");
		expect(callback).not.toHaveBeenCalled();
	});

	it("calls callback normally when slug matches current project", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		const callback = vi.fn();
		mod.onNavigateToSession(callback);
		mod.initSWNavigationListener();

		getCurrentSlugMock.mockReturnValue("my-project");

		postSWMessage({
			type: "navigate_to_session",
			sessionId: "sess-789",
			slug: "my-project",
		});

		expect(callback).toHaveBeenCalledWith("sess-789");
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("silently drops messages when no callback is registered", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		// Do NOT register a callback
		mod.initSWNavigationListener();

		// Should not throw
		expect(() => {
			postSWMessage({
				type: "navigate_to_session",
				sessionId: "sess-orphan",
				slug: "test-project",
			});
		}).not.toThrow();

		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("clearNavigateToSession prevents subsequent navigation", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		const callback = vi.fn();
		mod.onNavigateToSession(callback);
		mod.initSWNavigationListener();

		// Verify it works first
		postSWMessage({
			type: "navigate_to_session",
			sessionId: "sess-first",
			slug: "test-project",
		});
		expect(callback).toHaveBeenCalledWith("sess-first");

		// Clear the callback
		mod.clearNavigateToSession();
		callback.mockClear();

		// Subsequent messages should be silently dropped
		postSWMessage({
			type: "navigate_to_session",
			sessionId: "sess-second",
			slug: "test-project",
		});
		expect(callback).not.toHaveBeenCalled();
	});
});
