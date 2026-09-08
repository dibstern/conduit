import { describe, expect, it } from "vitest";
import { XTERM_THEMES } from "../../../src/lib/frontend/utils/xterm-themes.js";

const HEX_KEYS = [
	"background",
	"foreground",
	"cursor",
	"cursorAccent",
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite",
] as const;

describe("xterm palettes", () => {
	for (const variant of ["dark", "light"] as const) {
		it(`${variant} defines every ANSI slot`, () => {
			const palette = XTERM_THEMES[variant];
			expect(Object.keys(palette)).toHaveLength(21);
			for (const key of HEX_KEYS) {
				expect(palette[key]).toMatch(/^#[0-9a-fA-F]{6}$/);
			}
			expect(palette.selectionBackground).toMatch(/^rgba\(/);
		});
	}
});
