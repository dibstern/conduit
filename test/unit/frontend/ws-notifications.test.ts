// ─── ws-notifications — _pushActive initialization ──────────────────────────
// Regression test: _pushActive must start as `false` on every page load,
// regardless of persisted settings. The push subscription is not automatically
// re-established — it requires the user to toggle it in NotifSettings, which
// calls setPushActive(true) only after the SW subscription succeeds.
//
// Reading `push: true` from localStorage would suppress browser notifications
// even though no SW subscription is active, creating a dead zone where neither
// browser nor push desktop notifications fire.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── localStorage mock ──────────────────────────────────────────────────────

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

describe("_pushActive initialization", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it("starts as false even when settings.push is persisted as true", async () => {
		// Regression: _pushActive must NOT read from localStorage. If it did,
		// browser Notification API notifications would be suppressed on page
		// load even though no SW subscription is active — creating a dead zone.
		const storage = createLocalStorageMock({
			"notif-settings": JSON.stringify({
				push: true,
				browser: false,
				sound: false,
			}),
		});
		vi.stubGlobal("localStorage", storage);

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		expect(mod.isPushActive()).toBe(false);
	});

	it("starts as false when no settings are persisted", async () => {
		const storage = createLocalStorageMock();
		vi.stubGlobal("localStorage", storage);

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		expect(mod.isPushActive()).toBe(false);
	});

	it("starts as false when settings.push is explicitly false", async () => {
		const storage = createLocalStorageMock({
			"notif-settings": JSON.stringify({
				push: false,
				browser: true,
				sound: false,
			}),
		});
		vi.stubGlobal("localStorage", storage);

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		expect(mod.isPushActive()).toBe(false);
	});

	it("starts as false when localStorage has invalid JSON", async () => {
		const storage = createLocalStorageMock({
			"notif-settings": "not-valid-json!!!",
		});
		vi.stubGlobal("localStorage", storage);

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		expect(mod.isPushActive()).toBe(false);
	});

	it("becomes true only when setPushActive(true) is called explicitly", async () => {
		const storage = createLocalStorageMock();
		vi.stubGlobal("localStorage", storage);

		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);

		expect(mod.isPushActive()).toBe(false);
		mod.setPushActive(true);
		expect(mod.isPushActive()).toBe(true);
		mod.setPushActive(false);
		expect(mod.isPushActive()).toBe(false);
	});
});
