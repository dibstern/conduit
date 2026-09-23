import type { ResolvedTheme } from "../stores/theme.svelte.js";

/** xterm.js takes literal colours, not CSS variables, so this is the one place
 *  the palette is duplicated. Keep it in step with the tokens in style.css: the
 *  ANSI slots mirror the status inks, and background/foreground mirror
 *  --color-code-bg and --color-text-secondary. Bright variants are the base hue
 *  nudged toward the theme's text colour. */
export const XTERM_THEMES = {
	dark: {
		background: "#0d0e11",
		foreground: "#a8afbb",
		cursor: "#eceef2",
		cursorAccent: "#0d0e11",
		selectionBackground: "rgba(45, 50, 59, 0.5)",
		black: "#0d0e11",
		red: "#f4607a",
		green: "#3fd69a",
		yellow: "#f4b740",
		blue: "#5aa9f5",
		magenta: "#fe3781",
		cyan: "#00e5ff",
		white: "#a8afbb",
		brightBlack: "#79818f",
		brightRed: "#f7798e",
		brightGreen: "#5cdfab",
		brightYellow: "#f7c55f",
		brightBlue: "#7bbaf7",
		brightMagenta: "#ff5691",
		brightCyan: "#1ae8ff",
		brightWhite: "#eceef2",
	},
	light: {
		background: "#eef0f5",
		foreground: "#4b525e",
		cursor: "#14171c",
		cursorAccent: "#f5f6f9",
		selectionBackground: "rgba(204, 210, 220, 0.5)",
		black: "#14171c",
		red: "#c11d40",
		green: "#0c7750",
		yellow: "#8a5500",
		blue: "#0f62c0",
		magenta: "#c9004f",
		cyan: "#006d7a",
		white: "#6c7481",
		brightBlack: "#4b525e",
		brightRed: "#a51836",
		brightGreen: "#0a6844",
		brightYellow: "#754800",
		brightBlue: "#0d54a4",
		brightMagenta: "#a80042",
		brightCyan: "#00626e",
		brightWhite: "#838b97",
	},
} as const satisfies Record<ResolvedTheme, Record<string, string>>;
