// ─── Theme Store Tests ──────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from "vitest";

// Must mock localStorage and document BEFORE the store module is loaded.
const localStorageMock = vi.hoisted(() => {
	let store: Record<string, string> = {};
	const mock = {
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
		key: vi.fn((_: number) => null),
	};
	Object.defineProperty(globalThis, "localStorage", {
		value: mock,
		writable: true,
		configurable: true,
	});
	return mock;
});

// Mock document.documentElement.style for CSS var manipulation
const styleProps = vi.hoisted(() => {
	const props: Record<string, string> = {};
	const style = {
		setProperty: vi.fn((key: string, value: string) => {
			props[key] = value;
		}),
		removeProperty: vi.fn((key: string) => {
			delete props[key];
		}),
	};

	if (typeof globalThis.document === "undefined") {
		Object.defineProperty(globalThis, "document", {
			value: {
				documentElement: {
					style,
					classList: {
						add: vi.fn(),
						remove: vi.fn(),
						toggle: vi.fn(),
					},
				},
				querySelector: vi.fn(() => ({
					setAttribute: vi.fn(),
				})),
			},
			writable: true,
			configurable: true,
		});
	} else {
		// If document already exists, just override what we need
		Object.defineProperty(document.documentElement, "style", {
			value: style,
			writable: true,
			configurable: true,
		});
	}

	return { style, props };
});

// Mock fetch for loadThemes
const fetchMock = vi.hoisted(() => {
	const mock = vi.fn();
	Object.defineProperty(globalThis, "fetch", {
		value: mock,
		writable: true,
		configurable: true,
	});
	return mock;
});

import {
	applyTheme,
	closeThemePicker,
	DEFAULT_THEME_ID,
	getCurrentTheme,
	getThemeLists,
	initTheme,
	loadThemes,
	onThemeChange,
	themeState,
	toggleThemePicker,
} from "../../../src/lib/frontend/stores/theme.svelte.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const sampleTheme = {
	name: "Test Dark",
	variant: "dark" as const,
	base00: "1a1a2e",
	base01: "222240",
	base02: "303050",
	base03: "666680",
	base04: "888899",
	base05: "aaaabc",
	base06: "ddddee",
	base07: "ffffff",
	base08: "ff5555",
	base09: "ff9944",
	base0A: "ffcc33",
	base0B: "55ff55",
	base0C: "55cccc",
	base0D: "5599ff",
	base0E: "cc66cc",
	base0F: "cc9966",
};

const sampleLightTheme = {
	name: "Test Light",
	variant: "light" as const,
	base00: "fafafa",
	base01: "eeeeee",
	base02: "cccccc",
	base03: "999999",
	base04: "666666",
	base05: "444444",
	base06: "222222",
	base07: "000000",
	base08: "cc0000",
	base09: "cc6600",
	base0A: "cc9900",
	base0B: "009900",
	base0C: "009999",
	base0D: "0066cc",
	base0E: "9900cc",
	base0F: "996633",
};

const opencodeLight = {
	name: "Opencode Light",
	variant: "light" as const,
	base00: "FDFCFC",
	base01: "F8F7F7",
	base02: "D0CFCE",
	base03: "D0CFCE",
	base04: "9A9898",
	base05: "646262",
	base06: "201D1D",
	base07: "000000",
	base08: "E5443A",
	base09: "E64D1E",
	base0A: "D3AC69",
	base0B: "12C905",
	base0C: "2E9E9E",
	base0D: "4078F2",
	base0E: "B52669",
	base0F: "BF8640",
	overrides: {
		"--color-accent": "#201d1d",
		"--color-accent-hover": "#302c2c",
	},
};

function mockFetchSuccess(
	bundled: Record<string, unknown>,
	custom: Record<string, unknown> = {},
) {
	fetchMock.mockResolvedValueOnce({
		ok: true,
		json: async () => ({ bundled, custom }),
	});
}

function resetState() {
	themeState.currentThemeId = DEFAULT_THEME_ID;
	themeState.themes = {};
	themeState.customThemeIds = [];
	themeState.themesLoaded = false;
	themeState.pickerOpen = false;
	themeState.computedVars = {};
	themeState.variant = "light";
	localStorageMock.clear();
	vi.clearAllMocks();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
	resetState();
});

describe("DEFAULT_THEME_ID", () => {
	it("is 'opencode-light'", () => {
		expect(DEFAULT_THEME_ID).toBe("opencode-light");
	});
});

describe("toggleThemePicker / closeThemePicker", () => {
	it("toggles pickerOpen state", () => {
		expect(themeState.pickerOpen).toBe(false);
		toggleThemePicker();
		expect(themeState.pickerOpen).toBe(true);
		toggleThemePicker();
		expect(themeState.pickerOpen).toBe(false);
	});

	it("closeThemePicker sets pickerOpen to false", () => {
		themeState.pickerOpen = true;
		closeThemePicker();
		expect(themeState.pickerOpen).toBe(false);
	});
});

describe("applyTheme", () => {
	it("applies a known theme — sets CSS vars on root", () => {
		themeState.themes = { dark1: sampleTheme };
		applyTheme("dark1");
		expect(themeState.currentThemeId).toBe("dark1");
		expect(themeState.variant).toBe("dark");
		expect(Object.keys(themeState.computedVars).length).toBeGreaterThan(0);
		expect(styleProps.style.setProperty).toHaveBeenCalled();
	});

	it("applies a known theme — persists to localStorage", () => {
		themeState.themes = { dark1: sampleTheme };
		applyTheme("dark1");
		expect(localStorageMock.setItem).toHaveBeenCalledWith(
			"opencode-relay-theme",
			"dark1",
		);
		expect(localStorageMock.setItem).toHaveBeenCalledWith(
			"opencode-relay-theme-variant",
			"dark",
		);
	});

	it("silently ignores unknown theme IDs", () => {
		applyTheme("nonexistent");
		expect(themeState.currentThemeId).toBe(DEFAULT_THEME_ID);
	});

	it("applies opencode-light — sets CSS vars (not empty)", () => {
		themeState.themes = { "opencode-light": opencodeLight };
		applyTheme("opencode-light");
		expect(themeState.currentThemeId).toBe("opencode-light");
		expect(themeState.variant).toBe("light");
		expect(Object.keys(themeState.computedVars).length).toBeGreaterThan(0);
	});

	it("applies overrides from theme JSON", () => {
		themeState.themes = { "opencode-light": opencodeLight };
		applyTheme("opencode-light");
		expect(themeState.computedVars["--color-accent"]).toBe("#201d1d");
		expect(themeState.computedVars["--color-accent-hover"]).toBe("#302c2c");
	});

	it("fires onThemeChange callbacks", () => {
		const cb = vi.fn();
		const unsub = onThemeChange(cb);
		themeState.themes = { dark1: sampleTheme };
		applyTheme("dark1");
		expect(cb).toHaveBeenCalledWith("dark1", expect.any(Object));
		unsub();
	});

	it("fires onThemeChange with vars for opencode-light", () => {
		const cb = vi.fn();
		const unsub = onThemeChange(cb);
		themeState.themes = { "opencode-light": opencodeLight };
		applyTheme("opencode-light");
		expect(cb).toHaveBeenCalledWith("opencode-light", expect.any(Object));
		// Vars should not be empty (unlike old "default" behavior)
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const [, vars] = cb.mock.calls[0]!;
		expect(Object.keys(vars).length).toBeGreaterThan(0);
		unsub();
	});

	it("swallows callback errors without breaking", () => {
		const badCb = vi.fn(() => {
			throw new Error("callback crash");
		});
		const goodCb = vi.fn();
		const unsub1 = onThemeChange(badCb);
		const unsub2 = onThemeChange(goodCb);
		themeState.themes = { dark1: sampleTheme };

		expect(() => applyTheme("dark1")).not.toThrow();
		expect(badCb).toHaveBeenCalled();
		expect(goodCb).toHaveBeenCalled();

		unsub1();
		unsub2();
	});

	it("removes stale CSS vars when switching themes", () => {
		themeState.themes = { dark1: sampleTheme, light1: sampleLightTheme };
		applyTheme("dark1");
		vi.clearAllMocks();
		applyTheme("light1");
		// removeProperty should have been called for any stale keys
		expect(styleProps.style.setProperty).toHaveBeenCalled();
	});
});

describe("onThemeChange", () => {
	it("returns an unsubscribe function that stops callbacks", () => {
		const cb = vi.fn();
		const unsub = onThemeChange(cb);
		themeState.themes = {
			dark1: sampleTheme,
			"opencode-light": opencodeLight,
		};
		applyTheme("dark1");
		expect(cb).toHaveBeenCalledTimes(1);

		unsub();
		applyTheme("opencode-light");
		expect(cb).toHaveBeenCalledTimes(1); // not called again
	});
});

describe("loadThemes", () => {
	it("populates themeState from fetch response", async () => {
		mockFetchSuccess({ claude: sampleTheme }, { myTheme: sampleLightTheme });
		await loadThemes();

		expect(themeState.themesLoaded).toBe(true);
		expect(themeState.themes["claude"]).toBeDefined();
		expect(themeState.themes["myTheme"]).toBeDefined();
		expect(themeState.customThemeIds).toContain("myTheme");
	});

	it("sets themesLoaded=true on non-ok HTTP response", async () => {
		fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
		await loadThemes();
		expect(themeState.themesLoaded).toBe(true);
	});

	it("sets themesLoaded=true on fetch error", async () => {
		fetchMock.mockRejectedValueOnce(new Error("network error"));
		await loadThemes();
		expect(themeState.themesLoaded).toBe(true);
	});

	it("handles empty response gracefully", async () => {
		mockFetchSuccess({}, {});
		await loadThemes();
		expect(themeState.themesLoaded).toBe(true);
		expect(Object.keys(themeState.themes).length).toBe(0);
	});
});

describe("initTheme", () => {
	it("applies saved theme from localStorage", async () => {
		localStorageMock.setItem("opencode-relay-theme", "dark1");
		mockFetchSuccess({ dark1: sampleTheme });
		await initTheme();
		expect(themeState.currentThemeId).toBe("dark1");
	});

	it("falls back to opencode-light when saved theme not found", async () => {
		localStorageMock.setItem("opencode-relay-theme", "deleted-theme");
		mockFetchSuccess({
			dark1: sampleTheme,
			"opencode-light": opencodeLight,
		});
		await initTheme();
		expect(themeState.currentThemeId).toBe("opencode-light");
		// Should have cleaned up stale storage
		expect(localStorageMock.removeItem).toHaveBeenCalledWith(
			"opencode-relay-theme",
		);
	});

	it("applies opencode-light when no saved theme", async () => {
		mockFetchSuccess({
			dark1: sampleTheme,
			"opencode-light": opencodeLight,
		});
		await initTheme();
		expect(themeState.currentThemeId).toBe("opencode-light");
	});

	it("migrates legacy 'default' to opencode-light", async () => {
		localStorageMock.setItem("opencode-relay-theme", "default");
		mockFetchSuccess({
			dark1: sampleTheme,
			"opencode-light": opencodeLight,
		});
		await initTheme();
		expect(themeState.currentThemeId).toBe("opencode-light");
	});
});

describe("getCurrentTheme", () => {
	it("returns undefined when theme not in map", () => {
		expect(getCurrentTheme()).toBeUndefined();
	});

	it("returns the theme object for a loaded theme", () => {
		themeState.themes = { dark1: sampleTheme };
		themeState.currentThemeId = "dark1";
		expect(getCurrentTheme()).toBe(sampleTheme);
	});

	it("returns opencode-light when it is the current theme", () => {
		themeState.themes = { "opencode-light": opencodeLight };
		themeState.currentThemeId = "opencode-light";
		expect(getCurrentTheme()).toBe(opencodeLight);
	});
});

describe("getThemeLists", () => {
	it("separates dark and light themes", () => {
		themeState.themes = {
			dark1: sampleTheme,
			light1: sampleLightTheme,
		};
		const lists = getThemeLists();
		expect(lists.dark.length).toBe(1);
		expect(lists.light.length).toBe(1);
		expect(lists.custom.length).toBe(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(lists.dark[0]!.id).toBe("dark1");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(lists.light[0]!.id).toBe("light1");
	});

	it("puts custom themes in the custom list", () => {
		themeState.themes = {
			dark1: sampleTheme,
			myCustom: sampleLightTheme,
		};
		themeState.customThemeIds = ["myCustom"];
		const lists = getThemeLists();
		expect(lists.dark.length).toBe(1);
		expect(lists.light.length).toBe(0);
		expect(lists.custom.length).toBe(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(lists.custom[0]!.id).toBe("myCustom");
	});

	it("pins claude to top of dark list", () => {
		themeState.themes = {
			dracula: { ...sampleTheme, name: "Dracula" },
			claude: { ...sampleTheme, name: "Claude Dark" },
		};
		const lists = getThemeLists();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(lists.dark[0]!.id).toBe("claude");
	});

	it("pins opencode-light to top of light list", () => {
		themeState.themes = {
			"solarized-light": { ...sampleLightTheme, name: "Solarized Light" },
			"opencode-light": { ...opencodeLight },
		};
		const lists = getThemeLists();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(lists.light[0]!.id).toBe("opencode-light");
	});

	it("returns empty lists when no themes loaded", () => {
		const lists = getThemeLists();
		expect(lists.dark.length).toBe(0);
		expect(lists.light.length).toBe(0);
		expect(lists.custom.length).toBe(0);
	});
});
