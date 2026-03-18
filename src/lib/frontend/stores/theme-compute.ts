import type { Base16Key, Base16Theme } from "../../shared-types.js";
import { BASE16_KEYS } from "../../shared-types.js";
import { darken, hexToRgba, lighten, mixColors } from "../utils/color.js";

export type { Base16Theme };

type Base16Colors = { [K in Base16Key]: string };

function extractColors(theme: Base16Theme): Base16Colors {
	const b = {} as Base16Colors;
	for (const key of BASE16_KEYS) {
		b[key] = `#${theme[key] ?? "000000"}`;
	}
	return b;
}

export function computeVars(theme: Base16Theme): Record<string, string> {
	const b = extractColors(theme);
	const isLight = theme.variant === "light";
	const vars: Record<string, string> = {
		"--color-bg": b.base00,
		"--color-bg-alt": b.base01,
		"--color-bg-surface": b.base01,
		"--color-text": b.base06,
		"--color-text-secondary": b.base05,
		"--color-text-muted": b.base04,
		"--color-text-dimmer": b.base03,
		"--color-accent": b.base09,
		"--color-accent-hover": isLight
			? darken(b.base09, 0.12)
			: lighten(b.base09, 0.12),
		"--color-accent-bg": hexToRgba(b.base09, 0.12),
		"--color-code-bg": isLight
			? darken(b.base00, 0.03)
			: darken(b.base00, 0.15),
		"--color-border": b.base02,
		"--color-border-subtle": mixColors(b.base00, b.base02, 0.6),
		"--color-input-bg": mixColors(b.base01, b.base02, 0.5),
		"--color-user-bubble": isLight
			? darken(b.base01, 0.03)
			: mixColors(b.base01, b.base02, 0.3),
		"--color-error": b.base08,
		"--color-success": b.base0B,
		"--color-thinking": b.base0A,
		"--color-thinking-bg": hexToRgba(b.base0A, 0.06),
		"--color-tool": b.base0D,
		"--color-tool-bg": hexToRgba(b.base0D, 0.04),
		"--color-sidebar-bg": isLight
			? darken(b.base00, 0.02)
			: darken(b.base00, 0.1),
		"--color-sidebar-hover": isLight
			? darken(b.base00, 0.06)
			: mixColors(b.base00, b.base01, 0.5),
		"--color-sidebar-active": isLight
			? darken(b.base01, 0.05)
			: mixColors(b.base01, b.base02, 0.5),
		"--color-warning": b.base0A,
		"--color-warning-bg": hexToRgba(b.base0A, 0.12),
		"--overlay-rgb": isLight ? "0,0,0" : "255,255,255",
		"--shadow-rgb": "0,0,0",
		"--hl-comment": b.base03,
		"--hl-keyword": b.base0E,
		"--hl-string": b.base0B,
		"--hl-number": b.base09,
		"--hl-function": b.base0D,
		"--hl-variable": b.base08,
		"--hl-type": b.base0A,
		"--hl-constant": b.base09,
		"--hl-tag": b.base08,
		"--hl-attr": b.base0D,
		"--hl-regexp": b.base0C,
		"--hl-meta": b.base0F,
		"--hl-builtin": b.base09,
		"--hl-symbol": b.base0F,
		"--hl-addition": b.base0B,
		"--hl-deletion": b.base08,
	};

	// Apply theme-specific overrides (e.g. custom accent separate from base09)
	if (theme.overrides) {
		for (const [key, value] of Object.entries(theme.overrides)) {
			if (key in vars) {
				vars[key] = value;
			}
		}
	}

	return vars;
}

export function computeTerminalTheme(
	theme: Base16Theme,
): Record<string, string> {
	const b = extractColors(theme);
	const isLight = theme.variant === "light";
	return {
		background: isLight ? darken(b.base00, 0.03) : darken(b.base00, 0.15),
		foreground: b.base05,
		cursor: b.base06,
		cursorAccent: b.base00,
		selectionBackground: hexToRgba(b.base02, 0.5),
		black: isLight ? b.base07 : b.base00,
		red: b.base08,
		green: b.base0B,
		yellow: b.base0A,
		blue: b.base0D,
		magenta: b.base0E,
		cyan: b.base0C,
		white: isLight ? b.base00 : b.base05,
		brightBlack: b.base03,
		brightRed: isLight ? darken(b.base08, 0.1) : lighten(b.base08, 0.1),
		brightGreen: isLight ? darken(b.base0B, 0.1) : lighten(b.base0B, 0.1),
		brightYellow: isLight ? darken(b.base0A, 0.1) : lighten(b.base0A, 0.1),
		brightBlue: isLight ? darken(b.base0D, 0.1) : lighten(b.base0D, 0.1),
		brightMagenta: isLight ? darken(b.base0E, 0.1) : lighten(b.base0E, 0.1),
		brightCyan: isLight ? darken(b.base0C, 0.1) : lighten(b.base0C, 0.1),
		brightWhite: b.base07,
	};
}

export function computeMermaidVars(theme: Base16Theme): {
	darkMode: boolean;
	background: string;
	primaryColor: string;
	primaryTextColor: string;
	primaryBorderColor: string;
	lineColor: string;
	secondaryColor: string;
	tertiaryColor: string;
	fontFamily: string;
} {
	const vars = computeVars(theme);
	const isLight = theme.variant === "light";
	return {
		darkMode: !isLight,
		background: vars["--color-code-bg"] ?? "",
		primaryColor: vars["--color-accent"] ?? "",
		primaryTextColor: vars["--color-text"] ?? "",
		primaryBorderColor: vars["--color-border"] ?? "",
		lineColor: vars["--color-text-muted"] ?? "",
		secondaryColor: vars["--color-bg-alt"] ?? "",
		tertiaryColor: vars["--color-bg"] ?? "",
		fontFamily: "'Berkeley Mono', 'IBM Plex Mono', ui-monospace, monospace",
	};
}
