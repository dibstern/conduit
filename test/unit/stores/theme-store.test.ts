import { beforeEach, describe, expect, it, vi } from "vitest";

const localStorageMock = vi.hoisted(() => {
	let values: Record<string, string> = {};
	return {
		getItem: vi.fn((key: string) => values[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			values[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete values[key];
		}),
		clear: vi.fn(() => {
			values = {};
		}),
	};
});

const rootClasses = vi.hoisted(() => new Set<string>());
const rootClassList = vi.hoisted(() => ({
	toggle: vi.fn((name: string, force?: boolean) => {
		if (force ?? !rootClasses.has(name)) rootClasses.add(name);
		else rootClasses.delete(name);
		return rootClasses.has(name);
	}),
}));

const matchMediaState = vi.hoisted(() => {
	let matches = false;
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	const query = {
		get matches() {
			return matches;
		},
		media: "(prefers-color-scheme: dark)",
		onchange: null,
		addEventListener: vi.fn(
			(_type: "change", listener: (event: MediaQueryListEvent) => void) => {
				listeners.add(listener);
			},
		),
		removeEventListener: vi.fn(
			(_type: "change", listener: (event: MediaQueryListEvent) => void) => {
				listeners.delete(listener);
			},
		),
	};

	return {
		matchMedia: vi.fn(() => query as unknown as MediaQueryList),
		setMatches(next: boolean) {
			matches = next;
			for (const listener of listeners) {
				listener({ matches: next } as MediaQueryListEvent);
			}
		},
		reset() {
			matches = false;
			listeners.clear();
		},
	};
});

vi.hoisted(() => {
	Object.defineProperty(globalThis, "localStorage", {
		value: localStorageMock,
		configurable: true,
	});
	Object.defineProperty(globalThis, "matchMedia", {
		value: matchMediaState.matchMedia,
		configurable: true,
	});

	if (typeof globalThis.document === "undefined") {
		Object.defineProperty(globalThis, "document", {
			value: {
				documentElement: { classList: rootClassList },
				querySelector: vi.fn(() => null),
			},
			configurable: true,
		});
	} else {
		Object.defineProperty(document.documentElement, "classList", {
			value: rootClassList,
			configurable: true,
		});
	}
});

import {
	initTheme,
	setThemeMode,
	themeState,
} from "../../../src/lib/frontend/stores/theme.svelte.js";

beforeEach(() => {
	localStorageMock.clear();
	matchMediaState.reset();
	rootClasses.clear();
	themeState.mode = "dark";
	themeState.resolved = "dark";
	vi.clearAllMocks();
});

describe("theme mode", () => {
	it("defaults to Dark and applies the dark class", () => {
		initTheme();

		expect(themeState.mode).toBe("dark");
		expect(themeState.resolved).toBe("dark");
		expect(rootClasses).toContain("dark-theme");
		expect(rootClasses).not.toContain("light-theme");
	});

	it("applies and persists an explicit mode", () => {
		setThemeMode("light");

		expect(themeState.mode).toBe("light");
		expect(themeState.resolved).toBe("light");
		expect(rootClasses).toContain("light-theme");
		expect(rootClasses).not.toContain("dark-theme");
		expect(localStorageMock.setItem).toHaveBeenCalledWith(
			"conduit-theme",
			"light",
		);
	});

	it("follows system preference and re-resolves when it changes", () => {
		matchMediaState.setMatches(false);
		setThemeMode("system");

		expect(themeState.mode).toBe("system");
		expect(themeState.resolved).toBe("light");
		expect(rootClasses).toContain("light-theme");

		matchMediaState.setMatches(true);

		expect(themeState.mode).toBe("system");
		expect(themeState.resolved).toBe("dark");
		expect(rootClasses).toContain("dark-theme");
		expect(rootClasses).not.toContain("light-theme");
	});

	it("restores a persisted mode", () => {
		localStorageMock.setItem("conduit-theme", "light");

		initTheme();

		expect(themeState.mode).toBe("light");
		expect(themeState.resolved).toBe("light");
		expect(rootClasses).toContain("light-theme");
	});

	it("falls back to Dark for an unknown persisted value", () => {
		localStorageMock.setItem("conduit-theme", "dracula");

		initTheme();

		expect(themeState.mode).toBe("dark");
		expect(themeState.resolved).toBe("dark");
		expect(rootClasses).toContain("dark-theme");
		expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
			"conduit-theme",
			"dark",
		);
	});

	it("stops following system preference after an explicit choice", () => {
		setThemeMode("system");
		setThemeMode("light");

		matchMediaState.setMatches(true);

		expect(themeState.mode).toBe("light");
		expect(themeState.resolved).toBe("light");
	});
});
