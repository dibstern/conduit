// Service worker notification clicks open sessions through selection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module mocks (must be declared before importing ws-notifications)

const getCurrentSlugMock = vi.fn(() => "test-project");
const navigateMock = vi.fn();
const openSession = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/frontend/stores/selection.svelte.js", () => ({
	selection: { open: openSession },
}));

vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: getCurrentSlugMock,
	navigate: navigateMock,
	getCurrentRoute: vi.fn(() => ({ page: "chat", slug: "test-project" })),
	getCurrentSessionId: vi.fn(() => null),
	routerState: { path: "/p/test-project/" },
	attachedProjectState: { slug: "test-project" },
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

/** Simulate the SW posting a message to the client. */
function postSWMessage(data: Record<string, unknown>): void {
	for (const fn of messageListeners) {
		fn({ data });
	}
}

type WSNotificationsModule =
	typeof import("../../../src/lib/frontend/stores/ws-notifications.js");

beforeEach(() => {
	vi.resetModules();
	messageListeners = [];
	addEventListenerMock.mockClear();
	getCurrentSlugMock.mockReturnValue("test-project");
	navigateMock.mockClear();
	openSession.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SW navigation listener", () => {
	it("registers a message listener on navigator.serviceWorker", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		mod.initSWMessageListener();

		expect(addEventListenerMock).toHaveBeenCalledWith(
			"message",
			expect.any(Function),
		);
	});

	it("only registers once even if called multiple times", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		mod.initSWMessageListener();
		mod.initSWMessageListener();
		mod.initSWMessageListener();

		expect(addEventListenerMock).toHaveBeenCalledTimes(1);
	});

	it("opens the session when SW posts navigate_to_session", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		mod.initSWMessageListener();

		postSWMessage({
			type: "navigate_to_session",
			sessionId: "sess-123",
			slug: "test-project",
		});

		expect(openSession).toHaveBeenCalledExactlyOnceWith("sess-123");
	});

	it("does not open a session when sessionId is missing", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		mod.initSWMessageListener();

		postSWMessage({
			type: "navigate_to_session",
		});

		expect(openSession).not.toHaveBeenCalled();
	});

	it("opens the session without URL navigation when slug differs from the current project", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		mod.initSWMessageListener();

		postSWMessage({
			type: "navigate_to_session",
			sessionId: "sess-456",
			slug: "other-project",
			url: "/p/other-project/s/sess-456",
		});

		expect(openSession).toHaveBeenCalledExactlyOnceWith("sess-456");
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("opens the session when slug matches the current project", async () => {
		const mod: WSNotificationsModule = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		mod.initSWMessageListener();

		getCurrentSlugMock.mockReturnValue("my-project");

		postSWMessage({
			type: "navigate_to_session",
			sessionId: "sess-789",
			slug: "my-project",
		});

		expect(openSession).toHaveBeenCalledExactlyOnceWith("sess-789");
		expect(navigateMock).not.toHaveBeenCalled();
	});
});
