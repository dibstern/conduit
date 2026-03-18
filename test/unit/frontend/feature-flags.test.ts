import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ─── localStorage mock (must be set before module import) ───────────────────
const storage = new Map<string, string>();
const localStorageMock = {
	getItem: vi.fn((key: string) => storage.get(key) ?? null),
	setItem: vi.fn((key: string, val: string) => storage.set(key, val)),
	removeItem: vi.fn((key: string) => storage.delete(key)),
	clear: vi.fn(() => storage.clear()),
};

beforeAll(() => {
	vi.stubGlobal("localStorage", localStorageMock);
});

import {
	disableFeature,
	enableFeature,
	featureFlags,
	getEnabledFeatures,
	isFeatureEnabled,
	parseFeatsParam,
	toggleFeature,
} from "../../../src/lib/frontend/stores/feature-flags.svelte.js";

describe("feature-flags", () => {
	beforeEach(() => {
		storage.clear();
		localStorageMock.getItem.mockClear();
		localStorageMock.setItem.mockClear();
		featureFlags.debug = false;
	});

	describe("parseFeatsParam", () => {
		it("parses comma-separated valid flags", () => {
			expect(parseFeatsParam("debug")).toEqual(["debug"]);
		});

		it("ignores unknown flag names", () => {
			expect(parseFeatsParam("debug,unknown,foo")).toEqual(["debug"]);
		});

		it("deduplicates flags", () => {
			expect(parseFeatsParam("debug,debug")).toEqual(["debug"]);
		});

		it("trims whitespace", () => {
			expect(parseFeatsParam(" debug , ")).toEqual(["debug"]);
		});

		it("is case-insensitive", () => {
			expect(parseFeatsParam("Debug,DEBUG")).toEqual(["debug"]);
		});

		it("returns empty for all-invalid input", () => {
			expect(parseFeatsParam("foo,bar")).toEqual([]);
		});

		it("returns empty for empty string", () => {
			expect(parseFeatsParam("")).toEqual([]);
		});
	});

	describe("enableFeature / disableFeature", () => {
		it("enableFeature sets flag and persists to localStorage", () => {
			enableFeature("debug");
			expect(featureFlags.debug).toBe(true);
			expect(localStorageMock.setItem).toHaveBeenCalledWith(
				"feature-flags",
				JSON.stringify(["debug"]),
			);
		});

		it("disableFeature clears flag and removes from localStorage", () => {
			enableFeature("debug");
			disableFeature("debug");
			expect(featureFlags.debug).toBe(false);
			expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
				"feature-flags",
				JSON.stringify([]),
			);
		});

		it("enableFeature is idempotent", () => {
			enableFeature("debug");
			enableFeature("debug");
			// Should only write once (second call sees it's already there)
			const setCalls = localStorageMock.setItem.mock.calls.filter(
				(c: string[]) => c[0] === "feature-flags",
			);
			expect(setCalls).toHaveLength(1);
		});
	});

	describe("toggleFeature", () => {
		it("toggles off → on", () => {
			toggleFeature("debug");
			expect(featureFlags.debug).toBe(true);
		});

		it("toggles on → off", () => {
			featureFlags.debug = true;
			storage.set("feature-flags", JSON.stringify(["debug"]));
			toggleFeature("debug");
			expect(featureFlags.debug).toBe(false);
		});
	});

	describe("isFeatureEnabled", () => {
		it("returns false when disabled", () => {
			expect(isFeatureEnabled("debug")).toBe(false);
		});

		it("returns true when enabled", () => {
			enableFeature("debug");
			expect(isFeatureEnabled("debug")).toBe(true);
		});
	});

	describe("getEnabledFeatures", () => {
		it("returns empty when no flags enabled", () => {
			expect(getEnabledFeatures()).toEqual([]);
		});

		it("returns enabled flags", () => {
			enableFeature("debug");
			expect(getEnabledFeatures()).toEqual(["debug"]);
		});
	});
});
