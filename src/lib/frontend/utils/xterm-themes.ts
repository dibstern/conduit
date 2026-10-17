import type { ResolvedTheme } from "../stores/theme.svelte.js";

/** xterm.js takes literal colours, not CSS variables, so this is the one place
 *  the palette is duplicated. Keep it in step with the tokens in style.css: the
 *  ANSI slots mirror the status inks (yellow is pinned gold, cyan the goal
 *  teal), and background/foreground mirror --color-code-bg and
 *  --color-text-secondary. Bright variants mix 15% toward the theme's text. */
export const XTERM_THEMES = {
	dark: {
		background: "#141416",
		foreground: "#a1a1aa",
		cursor: "#ededf0",
		cursorAccent: "#141416",
		selectionBackground: "rgba(43, 43, 49, 0.5)",
		black: "#141416",
		red: "#ff6369",
		green: "#3ecf8e",
		yellow: "#f2c14e",
		blue: "#8e9bff",
		magenta: "#f469c4",
		cyan: "#3fd0bf",
		white: "#a1a1aa",
		brightBlack: "#80808a",
		brightRed: "#fc787d",
		brightGreen: "#58d49d",
		brightYellow: "#f1c866",
		brightBlue: "#9ca7fd",
		brightMagenta: "#f37dcb",
		brightCyan: "#59d4c6",
		brightWhite: "#ededf0",
	},
	light: {
		background: "#fafafa",
		foreground: "#5d5d66",
		cursor: "#0b0b0d",
		cursorAccent: "#ffffff",
		selectionBackground: "rgba(227, 227, 231, 0.5)",
		black: "#0b0b0d",
		red: "#d02222",
		green: "#147b3b",
		yellow: "#8d6400",
		blue: "#4c5bd4",
		magenta: "#c0267f",
		cyan: "#0c786c",
		white: "#6e6e77",
		brightBlack: "#5d5d66",
		brightRed: "#b21f1f",
		brightGreen: "#136a34",
		brightYellow: "#7a5702",
		brightBlue: "#424fb6",
		brightMagenta: "#a5226e",
		brightCyan: "#0c685e",
		brightWhite: "#868692",
	},
} as const satisfies Record<ResolvedTheme, Record<string, string>>;
