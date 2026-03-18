// ─── triggerNotifications behavior tests ─────────────────────────────────────
// Tests the actual notification firing logic which previously had ZERO coverage.
// Exercises: document.hidden gating, sound playback, browser Notification API,
// push suppression, notificationContent integration, and NOTIF_TYPES matching.
//
// Separate file from ws-notifications.test.ts because vi.mock() for sound.js
// and notif-settings.js gets hoisted and would break the _pushActive init tests
// (which rely on the real getNotifSettings reading from localStorage).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── Hoisted mocks (run before imports) ─────────────────────────────────────

const { playDoneSoundMock, getNotifSettingsMock } = vi.hoisted(() => {
	const playDoneSoundMock = vi.fn();
	const getNotifSettingsMock = vi.fn();
	return { playDoneSoundMock, getNotifSettingsMock };
});

vi.mock("../../../src/lib/frontend/utils/sound.js", () => ({
	playDoneSound: playDoneSoundMock,
}));

vi.mock("../../../src/lib/frontend/utils/notif-settings.js", () => ({
	getNotifSettings: getNotifSettingsMock,
	saveNotifSettings: vi.fn(),
}));

// ─── localStorage mock (needed by ws-notifications module init) ─────────────

function createLocalStorageMock(initial?: Record<string, string>) {
	let store: Record<string, string> = { ...initial };
	return {
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
		key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("triggerNotifications", () => {
	// Track Notification constructor calls
	let notificationInstances: Array<{
		title: string;
		options: NotificationOptions;
		close: ReturnType<typeof vi.fn>;
		onclick: ((this: Notification, ev: Event) => unknown) | null;
	}>;

	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
		playDoneSoundMock.mockClear();
		getNotifSettingsMock.mockClear();
		notificationInstances = [];

		// Stub document with hidden=true (tab is background)
		vi.stubGlobal("document", { hidden: true });

		// Mock Notification constructor
		const MockNotification = vi.fn(
			(title: string, options?: NotificationOptions) => {
				const instance = {
					title,
					options: options ?? {},
					close: vi.fn(),
					onclick: null as ((this: Notification, ev: Event) => unknown) | null,
				};
				notificationInstances.push(instance);
				return instance;
			},
		);
		Object.defineProperty(MockNotification, "permission", {
			value: "granted",
			writable: true,
			configurable: true,
		});
		vi.stubGlobal("Notification", MockNotification);

		// Default settings: browser=true, sound=false, push=false
		getNotifSettingsMock.mockReturnValue({
			push: false,
			browser: true,
			sound: false,
		});

		// localStorage stub (needed for module to load without errors)
		const storage = createLocalStorageMock();
		vi.stubGlobal("localStorage", storage);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// ─── Core behavior: fires for notification-worthy types ─────────────

	it("fires browser notification for 'done' message when tab is hidden", async () => {
		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.triggerNotifications({ type: "done" } as RelayMessage);

		expect(notificationInstances).toHaveLength(1);
		expect(notificationInstances[0]?.title).toBe("Task Complete");
		expect(notificationInstances[0]?.options.body).toBe(
			"Agent has finished processing.",
		);
		expect(notificationInstances[0]?.options.tag).toBe("opencode-done");
	});

	it("fires browser notification for 'error' message", async () => {
		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.triggerNotifications({
			type: "error",
			message: "Something broke",
			code: "UNKNOWN",
		} as RelayMessage);

		expect(notificationInstances).toHaveLength(1);
		expect(notificationInstances[0]?.title).toBe("Error");
		expect(notificationInstances[0]?.options.body).toBe("Something broke");
	});

	it("fires browser notification for 'permission_request' message", async () => {
		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.triggerNotifications({
			type: "permission_request",
			toolName: "bash",
			requestId: "req-123",
		} as RelayMessage);

		expect(notificationInstances).toHaveLength(1);
		expect(notificationInstances[0]?.title).toBe("Permission Needed");
		expect(notificationInstances[0]?.options.body).toBe("bash needs approval");
		expect(notificationInstances[0]?.options.tag).toBe("perm-req-123");
	});

	it("fires browser notification for 'ask_user' message", async () => {
		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.triggerNotifications({
			type: "ask_user",
			toolId: "q-456",
			questions: [{ question: "What?", header: "" }],
		} as RelayMessage);

		expect(notificationInstances).toHaveLength(1);
		expect(notificationInstances[0]?.title).toBe("Question from Agent");
	});

	// ─── Gating: non-notification types are ignored ─────────────────────

	it("does NOT fire for non-notification types (delta, status, etc.)", async () => {
		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.triggerNotifications({ type: "delta", text: "hello" } as RelayMessage);
		mod.triggerNotifications({
			type: "status",
			status: "processing",
		} as RelayMessage);
		mod.triggerNotifications({
			type: "tool_start",
			id: "t1",
			name: "bash",
		} as RelayMessage);

		expect(notificationInstances).toHaveLength(0);
		expect(playDoneSoundMock).not.toHaveBeenCalled();
	});

	// ─── Tab visibility: notifications fire regardless ──────────────────

	it("fires browser notification AND sound when tab is visible", async () => {
		vi.stubGlobal("document", { hidden: false });
		getNotifSettingsMock.mockReturnValue({
			push: false,
			browser: true,
			sound: true,
		});

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.triggerNotifications({ type: "done" } as RelayMessage);

		expect(notificationInstances).toHaveLength(1);
		expect(playDoneSoundMock).toHaveBeenCalledOnce();
	});

	// ─── Sound ──────────────────────────────────────────────────────────

	it("plays sound when settings.sound is true", async () => {
		getNotifSettingsMock.mockReturnValue({
			push: false,
			browser: false,
			sound: true,
		});

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.triggerNotifications({ type: "done" } as RelayMessage);

		expect(playDoneSoundMock).toHaveBeenCalledOnce();
	});

	it("does NOT play sound when settings.sound is false", async () => {
		getNotifSettingsMock.mockReturnValue({
			push: false,
			browser: true,
			sound: false,
		});

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.triggerNotifications({ type: "done" } as RelayMessage);

		expect(playDoneSoundMock).not.toHaveBeenCalled();
	});

	// ─── Push suppression ───────────────────────────────────────────────

	it("suppresses browser notification when push is active", async () => {
		getNotifSettingsMock.mockReturnValue({
			push: false,
			browser: true,
			sound: false,
		});

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		// Activate push (simulates user enabling push notifications)
		mod.setPushActive(true);

		mod.triggerNotifications({ type: "done" } as RelayMessage);

		// Browser notification should NOT fire because push is active
		expect(notificationInstances).toHaveLength(0);
	});

	it("fires browser notification when push is NOT active", async () => {
		getNotifSettingsMock.mockReturnValue({
			push: false,
			browser: true,
			sound: false,
		});

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.setPushActive(false);

		mod.triggerNotifications({ type: "done" } as RelayMessage);

		expect(notificationInstances).toHaveLength(1);
	});

	// ─── Browser setting disabled ───────────────────────────────────────

	it("does NOT fire browser notification when settings.browser is false", async () => {
		getNotifSettingsMock.mockReturnValue({
			push: false,
			browser: false,
			sound: false,
		});

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.triggerNotifications({ type: "done" } as RelayMessage);

		expect(notificationInstances).toHaveLength(0);
	});

	// ─── Notification.permission not granted ────────────────────────────

	it("does NOT fire browser notification when Notification.permission is denied", async () => {
		Object.defineProperty(Notification, "permission", {
			value: "denied",
			writable: true,
			configurable: true,
		});

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.triggerNotifications({ type: "done" } as RelayMessage);

		expect(notificationInstances).toHaveLength(0);
	});

	// ─── Sound is independent of push ───────────────────────────────────

	it("plays sound even when push is active (sound is independent)", async () => {
		getNotifSettingsMock.mockReturnValue({
			push: false,
			browser: true,
			sound: true,
		});

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		mod.setPushActive(true);

		mod.triggerNotifications({ type: "done" } as RelayMessage);

		// Sound should play regardless of push state
		expect(playDoneSoundMock).toHaveBeenCalledOnce();
		// But browser notification should be suppressed
		expect(notificationInstances).toHaveLength(0);
	});
});
