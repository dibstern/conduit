// ─── Notification Settings — Unit Tests ──────────────────────────────────────
// Tests getNotifSettings / saveNotifSettings localStorage round-trip.

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	getNotifSettings,
	saveNotifSettings,
} from "../../../src/lib/frontend/utils/notif-settings.js";

// ─── localStorage mock ───────────────────────────────────────────────────────

const localStorageMock = (() => {
	let store: Record<string, string> = {};
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
})();

beforeEach(() => {
	localStorageMock.clear();
	localStorageMock.getItem.mockClear();
	localStorageMock.setItem.mockClear();
	vi.stubGlobal("localStorage", localStorageMock);
});

// ─── getNotifSettings ────────────────────────────────────────────────────────

describe("getNotifSettings", () => {
	test("returns defaults when localStorage is empty", () => {
		const settings = getNotifSettings();
		expect(settings).toEqual({
			push: false,
			browser: true,
			sound: false,
		});
	});

	test("reads stored settings", () => {
		localStorageMock.setItem(
			"notif-settings",
			JSON.stringify({ push: true, browser: false, sound: true }),
		);
		const settings = getNotifSettings();
		expect(settings).toEqual({
			push: true,
			browser: false,
			sound: true,
		});
	});

	test("fills in defaults for missing fields", () => {
		localStorageMock.setItem("notif-settings", JSON.stringify({ push: true }));
		const settings = getNotifSettings();
		expect(settings).toEqual({
			push: true,
			browser: true,
			sound: false,
		});
	});

	test("returns defaults for invalid JSON", () => {
		localStorageMock.setItem("notif-settings", "not-json!!!");
		const settings = getNotifSettings();
		expect(settings).toEqual({
			push: false,
			browser: true,
			sound: false,
		});
	});

	test("ignores non-boolean values in stored settings", () => {
		localStorageMock.setItem(
			"notif-settings",
			JSON.stringify({ push: "yes", browser: 1, sound: null }),
		);
		const settings = getNotifSettings();
		expect(settings).toEqual({
			push: false,
			browser: true,
			sound: false,
		});
	});

	test("returns a new object each call (not a shared reference)", () => {
		const s1 = getNotifSettings();
		const s2 = getNotifSettings();
		expect(s1).toEqual(s2);
		expect(s1).not.toBe(s2);
	});

	test("uses correct localStorage key", () => {
		getNotifSettings();
		expect(localStorageMock.getItem).toHaveBeenCalledWith("notif-settings");
	});
});

// ─── saveNotifSettings ───────────────────────────────────────────────────────

describe("saveNotifSettings", () => {
	test("stores settings to localStorage", () => {
		saveNotifSettings({ push: true, browser: false, sound: true });
		expect(localStorageMock.setItem).toHaveBeenCalledWith(
			"notif-settings",
			JSON.stringify({ push: true, browser: false, sound: true }),
		);
	});

	test("round-trips correctly", () => {
		const original = { push: true, browser: false, sound: true };
		saveNotifSettings(original);
		const loaded = getNotifSettings();
		expect(loaded).toEqual(original);
	});

	test("uses correct localStorage key", () => {
		saveNotifSettings({ push: false, browser: true, sound: false });
		expect(localStorageMock.setItem).toHaveBeenCalledWith(
			"notif-settings",
			expect.any(String),
		);
	});
});
