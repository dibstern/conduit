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
const scrims = new Set<{
	opacity: number | (() => number);
	backdrop: "default" | "dark" | "subtle";
}>();

function themeChannels(colour: string): number[] {
	if (colour.startsWith("#")) {
		let hex = colour.slice(1);
		if (hex.length === 3 || hex.length === 4) {
			hex = [...hex].map((digit) => digit + digit).join("");
		}
		return [0, 2, 4]
			.map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
			.concat(
				hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
			);
	}
	const channels = colour.match(/[\d.]+/g)?.map(Number) ?? [];
	return channels.length === 3 ? [...channels, 1] : channels;
}

function syncThemeColor(): void {
	const style = getComputedStyle(document.documentElement);
	const background = style.getPropertyValue("--color-bg").trim();
	if (!background) return;
	// CSS minification shortens hex backgrounds and serializes rgba as hex alpha.
	let channels = themeChannels(background).slice(0, 3);
	if (channels.length !== 3 || !channels.every(Number.isFinite)) return;
	for (const scrim of scrims) {
		const token =
			scrim.backdrop === "default"
				? "--color-backdrop"
				: `--color-backdrop-${scrim.backdrop}`;
		const backdrop = themeChannels(style.getPropertyValue(token).trim());
		if (backdrop.length !== 4 || !backdrop.every(Number.isFinite)) continue;
		const opacity =
			typeof scrim.opacity === "function" ? scrim.opacity() : scrim.opacity;
		const alpha = (backdrop[3] ?? 0) * opacity;
		channels = channels.map(
			(channel, index) =>
				channel * (1 - alpha) + (backdrop[index] ?? 0) * alpha,
		);
	}
	const colour = `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
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

/** Keep browser chrome aligned with each visible phone scrim, including nested sheets. */
export function dimThemeColor(
	opacity: number | (() => number) = 1,
	backdrop: "default" | "dark" | "subtle" = "default",
): () => void {
	const scrim = { opacity, backdrop };
	scrims.add(scrim);
	syncThemeColor();
	return () => {
		scrims.delete(scrim);
		syncThemeColor();
	};
}

/** Follow painted opacity while a phone scrim tracks a drag or settles. */
export function themeColorScrim(
	node: HTMLElement,
	{
		backdrop = "default",
		pseudoElement,
	}: {
		backdrop?: "default" | "dark" | "subtle";
		pseudoElement?: string;
	} = {},
): { destroy: () => void } {
	const restore = dimThemeColor(
		() => Number.parseFloat(getComputedStyle(node, pseudoElement).opacity),
		backdrop,
	);
	let frame: number | undefined;
	const sample = () => {
		syncThemeColor();
		frame = requestAnimationFrame(sample);
	};
	const stop = () => {
		if (frame !== undefined) cancelAnimationFrame(frame);
		frame = undefined;
		syncThemeColor();
	};
	const transition = (event: TransitionEvent) => {
		if (
			event.target !== node ||
			event.propertyName !== "opacity" ||
			event.pseudoElement !== (pseudoElement ?? "")
		)
			return;
		stop();
		if (event.type === "transitionrun") sample();
	};
	const observer = new MutationObserver(syncThemeColor);
	observer.observe(node, {
		attributes: true,
		attributeFilter: ["style", "class"],
	});
	node.addEventListener("transitionrun", transition);
	node.addEventListener("transitionend", transition);
	node.addEventListener("transitioncancel", transition);
	return {
		destroy: () => {
			observer.disconnect();
			node.removeEventListener("transitionrun", transition);
			node.removeEventListener("transitionend", transition);
			node.removeEventListener("transitioncancel", transition);
			if (frame !== undefined) cancelAnimationFrame(frame);
			restore();
		},
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
