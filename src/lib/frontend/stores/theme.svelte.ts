export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<ThemeMode, "system">;

export const themeState = $state<{
	mode: ThemeMode;
	resolved: ResolvedTheme;
}>({
	mode: "dark",
	resolved: "dark",
});

let systemPreference: MediaQueryList | null = null;
let openScrims = 0;

function syncThemeColor(): void {
	const style = getComputedStyle(document.documentElement);
	const colour = style
		.getPropertyValue(openScrims > 0 ? "--color-theme-scrim" : "--color-bg")
		.trim();
	if (!colour) return;
	let meta = document.querySelector<HTMLMetaElement>(
		'meta[name="theme-color"]',
	);
	if (!meta) {
		meta = document.createElement("meta");
		meta.name = "theme-color";
		document.head.append(meta);
	}
	meta.content = colour;
}

/** Keep browser chrome dimmed until the last phone scrim closes. */
export function dimThemeColor(): () => void {
	openScrims++;
	syncThemeColor();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		openScrims--;
		syncThemeColor();
	};
}

function isThemeMode(value: string | null): value is ThemeMode {
	return value === "light" || value === "dark" || value === "system";
}

function applyResolvedTheme(resolved: ResolvedTheme): void {
	const root = document.documentElement;
	root.classList.toggle("light-theme", resolved === "light");
	root.classList.toggle("dark-theme", resolved === "dark");
	themeState.resolved = resolved;

	if (typeof getComputedStyle === "function") {
		syncThemeColor();
	}
}

function handleSystemPreferenceChange(event: MediaQueryListEvent): void {
	if (themeState.mode === "system") {
		applyResolvedTheme(event.matches ? "dark" : "light");
	}
}

export function setThemeMode(mode: ThemeMode): void {
	systemPreference?.removeEventListener("change", handleSystemPreferenceChange);
	systemPreference = null;

	themeState.mode = mode;
	if (mode === "system" && typeof matchMedia === "function") {
		systemPreference = matchMedia("(prefers-color-scheme: dark)");
		systemPreference.addEventListener("change", handleSystemPreferenceChange);
		applyResolvedTheme(systemPreference.matches ? "dark" : "light");
	} else {
		applyResolvedTheme(mode === "light" ? "light" : "dark");
	}
	try {
		localStorage.setItem("conduit-theme", mode);
	} catch {
		// localStorage may be unavailable in sandboxed or private contexts.
	}
}

export function initTheme(): void {
	let storedMode: string | null = null;
	try {
		storedMode = localStorage.getItem("conduit-theme");
	} catch {
		// localStorage may be unavailable in sandboxed or private contexts.
	}
	setThemeMode(isThemeMode(storedMode) ? storedMode : "dark");
}
