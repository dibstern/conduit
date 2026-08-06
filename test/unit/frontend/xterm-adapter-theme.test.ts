import { describe, expect, it } from "vitest";
import {
	type Base16Theme,
	computeTerminalTheme,
} from "../../../src/lib/frontend/stores/theme-compute.js";
import { ANSI_THEME } from "../../../src/lib/frontend/utils/xterm-adapter.js";
import conduitTheme from "../../../src/lib/themes/conduit.json" with {
	type: "json",
};

describe("ANSI_THEME (xterm-adapter default palette)", () => {
	it("is derived from the bundled conduit theme via computeTerminalTheme, not hand-picked", () => {
		expect(ANSI_THEME).toEqual(
			computeTerminalTheme(conduitTheme as Base16Theme),
		);
	});

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
	];

	it("has exactly the 20 hex ANSI/base slots, each a valid 6-digit hex string", () => {
		expect(HEX_KEYS).toHaveLength(20);
		for (const key of HEX_KEYS) {
			expect(ANSI_THEME[key]).toMatch(/^#[0-9a-fA-F]{6}$/);
		}
	});

	it("selectionBackground is theme-derived rgba, not a hand-picked literal", () => {
		expect(ANSI_THEME["selectionBackground"]).toMatch(/^rgba\(/);
	});
});
