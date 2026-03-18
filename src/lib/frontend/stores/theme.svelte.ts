import type { Base16Theme } from "./theme-compute.js";
import {
	computeMermaidVars,
	computeTerminalTheme,
	computeVars,
} from "./theme-compute.js";

export { computeTerminalTheme, computeMermaidVars };
export type { Base16Theme };

export const DEFAULT_THEME_ID = "opencode-light";

const STORAGE_KEY_THEME = "opencode-relay-theme";
const STORAGE_KEY_VARS = "opencode-relay-theme-vars";
const STORAGE_KEY_VARIANT = "opencode-relay-theme-variant";

/** All CSS variable keys that computeVars() can produce.
 *  Used when switching themes to remove stale vars from the previous theme
 *  or from the flash-prevention inline script. */
const ALL_CSS_VAR_KEYS = [
	"--color-bg",
	"--color-bg-alt",
	"--color-bg-surface",
	"--color-text",
	"--color-text-secondary",
	"--color-text-muted",
	"--color-text-dimmer",
	"--color-accent",
	"--color-accent-hover",
	"--color-accent-bg",
	"--color-code-bg",
	"--color-border",
	"--color-border-subtle",
	"--color-input-bg",
	"--color-user-bubble",
	"--color-error",
	"--color-success",
	"--color-thinking",
	"--color-thinking-bg",
	"--color-tool",
	"--color-tool-bg",
	"--color-sidebar-bg",
	"--color-sidebar-hover",
	"--color-sidebar-active",
	"--color-warning",
	"--color-warning-bg",
	"--overlay-rgb",
	"--shadow-rgb",
	"--hl-comment",
	"--hl-keyword",
	"--hl-string",
	"--hl-number",
	"--hl-function",
	"--hl-variable",
	"--hl-type",
	"--hl-constant",
	"--hl-tag",
	"--hl-attr",
	"--hl-regexp",
	"--hl-meta",
	"--hl-builtin",
	"--hl-symbol",
	"--hl-addition",
	"--hl-deletion",
];

export const themeState = $state({
	currentThemeId: DEFAULT_THEME_ID,
	themes: {} as Record<string, Base16Theme>,
	customThemeIds: [] as string[],
	themesLoaded: false,
	pickerOpen: false,
	computedVars: {} as Record<string, string>,
	variant: "light" as "light" | "dark",
});

type ThemeChangeCallback = (
	themeId: string,
	vars: Record<string, string>,
) => void;
const changeCallbacks = new Set<ThemeChangeCallback>();

/** Register a theme-change listener. Returns an unsubscribe function. */
export function onThemeChange(cb: ThemeChangeCallback): () => void {
	changeCallbacks.add(cb);
	return () => {
		changeCallbacks.delete(cb);
	};
}

export function toggleThemePicker(): void {
	themeState.pickerOpen = !themeState.pickerOpen;
}

export function closeThemePicker(): void {
	themeState.pickerOpen = false;
}

export function applyTheme(themeId: string): void {
	const theme = themeState.themes[themeId];
	if (!theme) return;

	const vars = computeVars(theme);
	const root = document.documentElement;

	// Remove any stale CSS vars from previous theme or flash-prevention script
	const staleKeys = new Set(Object.keys(themeState.computedVars));
	for (const key of ALL_CSS_VAR_KEYS) {
		staleKeys.add(key);
	}
	for (const key of staleKeys) {
		if (!(key in vars)) {
			root.style.removeProperty(key);
		}
	}

	for (const [key, value] of Object.entries(vars)) {
		root.style.setProperty(key, value);
	}

	const isLight = theme.variant === "light";
	root.classList.toggle("light-theme", isLight);
	root.classList.toggle("dark-theme", !isLight);

	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute("content", vars["--color-bg"] ?? "");

	themeState.currentThemeId = themeId;
	themeState.computedVars = vars;
	themeState.variant = theme.variant;

	try {
		localStorage.setItem(STORAGE_KEY_THEME, themeId);
		localStorage.setItem(STORAGE_KEY_VARS, JSON.stringify(vars));
		localStorage.setItem(STORAGE_KEY_VARIANT, theme.variant);
	} catch {
		// localStorage may be full or unavailable (private browsing)
	}

	for (const cb of changeCallbacks) {
		try {
			cb(themeId, vars);
		} catch {
			// Ignore callback errors
		}
	}
}

export async function loadThemes(): Promise<void> {
	try {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 5_000);
		const res = await fetch("/api/themes", { signal: ac.signal });
		clearTimeout(timer);
		if (!res.ok) {
			themeState.themesLoaded = true;
			return;
		}
		const data = await res.json();
		const all: Record<string, Base16Theme> = {};
		const customIds: string[] = [];

		if (data.bundled) {
			for (const [id, theme] of Object.entries(data.bundled)) {
				all[id] = theme as Base16Theme;
			}
		}
		if (data.custom) {
			for (const [id, theme] of Object.entries(data.custom)) {
				all[id] = theme as Base16Theme;
				customIds.push(id);
			}
		}

		themeState.themes = all;
		themeState.customThemeIds = customIds;
		themeState.themesLoaded = true;
	} catch {
		// Failed to load themes — still mark as loaded so UI doesn't hang
		themeState.themesLoaded = true;
	}
}

export async function initTheme(): Promise<void> {
	await loadThemes();
	let saved: string | null = null;
	try {
		saved = localStorage.getItem(STORAGE_KEY_THEME);
	} catch {
		// localStorage unavailable (sandboxed iframe, disabled storage)
	}

	// Migrate legacy "default" → "opencode-light"
	if (saved === "default") {
		saved = DEFAULT_THEME_ID;
	}

	if (saved && themeState.themes[saved]) {
		applyTheme(saved);
	} else {
		// Saved theme not found — clear stale storage, apply default
		if (saved && !themeState.themes[saved]) {
			try {
				localStorage.removeItem(STORAGE_KEY_THEME);
				localStorage.removeItem(STORAGE_KEY_VARS);
				localStorage.removeItem(STORAGE_KEY_VARIANT);
			} catch {
				// ignore
			}
		}
		applyTheme(DEFAULT_THEME_ID);
	}
}

export function getCurrentTheme(): Base16Theme | undefined {
	return themeState.themes[themeState.currentThemeId];
}

export function getThemeLists(): {
	dark: Array<{ id: string; theme: Base16Theme }>;
	light: Array<{ id: string; theme: Base16Theme }>;
	custom: Array<{ id: string; theme: Base16Theme }>;
} {
	const dark: Array<{ id: string; theme: Base16Theme }> = [];
	const light: Array<{ id: string; theme: Base16Theme }> = [];
	const custom: Array<{ id: string; theme: Base16Theme }> = [];

	for (const [id, theme] of Object.entries(themeState.themes)) {
		const entry = { id, theme };
		if (themeState.customThemeIds.includes(id)) {
			custom.push(entry);
		} else if (theme.variant === "dark") {
			dark.push(entry);
		} else {
			light.push(entry);
		}
	}

	const pinFirst = (
		list: Array<{ id: string; theme: Base16Theme }>,
		pinnedId: string,
	) => {
		const idx = list.findIndex((e) => e.id === pinnedId);
		if (idx > 0) list.unshift(...list.splice(idx, 1));
	};
	pinFirst(dark, "claude");
	pinFirst(light, DEFAULT_THEME_ID);

	return { dark, light, custom };
}
