import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { XTERM_THEMES } from "../../../src/lib/frontend/utils/xterm-themes.js";

const style = readFileSync(
	new URL("../../../src/lib/frontend/style.css", import.meta.url),
	"utf8",
);
const surfaces = [
	"bg",
	"bg-alt",
	"bg-surface",
	"code-bg",
	"input-bg",
	"user-bubble",
	"sidebar-bg",
	"sidebar-hover",
	"sidebar-active",
];
const textTokens = [
	"text",
	"text-secondary",
	"text-muted",
	"text-dimmer",
	"accent",
	"accent-hover",
	"error",
	"success",
	"warning",
	"thinking",
	"tool",
	"brand-a",
	"brand-b",
];
const syntaxTokens = [
	"comment",
	"keyword",
	"string",
	"number",
	"function",
	"variable",
	"type",
	"constant",
	"tag",
	"attr",
	"regexp",
	"meta",
	"builtin",
	"symbol",
	"addition",
	"deletion",
];
// ANSI black is conventionally the surface tone and is excluded from the floor.
const ansiTextSlots = [
	"foreground",
	"cursor",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
] as const;

// WCAG relative luminance and ratio, salvaged from the contrast-floor branch.
function relativeLuminance(hex: string): number {
	if (!/^#[0-9a-f]{6}$/i.test(hex)) {
		throw new Error(`Expected a six-digit hex colour, received ${hex}`);
	}
	const channel = (offset: number): number => {
		const s = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrastRatio(foreground: string, background: string): number {
	const l1 = relativeLuminance(foreground);
	const l2 = relativeLuminance(background);
	return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe.each(["dark", "light"] as const)("%s theme contrast", (variant) => {
	const block = (
		variant === "dark"
			? /@theme\s*\{([^}]+)\}/
			: /:root\.light-theme\s*\{([^}]+)\}/
	).exec(style)?.[1];
	if (!block)
		throw new Error(`style.css is missing the ${variant} theme block`);
	const tokens = Object.fromEntries(
		Array.from(block.matchAll(/(--[\w-]+):\s*([^;]+);/g), (match) => [
			match[1],
			match[2]?.trim(),
		]),
	);
	function colour(token: string): string {
		const value = tokens[token];
		if (value === undefined) throw new Error(`${variant} is missing ${token}`);
		return value;
	}

	it.each(
		textTokens.flatMap((token) =>
			surfaces.map((surface) => [token, surface] as const),
		),
	)("%s text on %s clears 4.5:1", (token, surface) => {
		expect(
			contrastRatio(colour(`--color-${token}`), colour(`--color-${surface}`)),
		).toBeGreaterThanOrEqual(4.5);
	});

	it.each(syntaxTokens)("syntax %s on code-bg clears 4.5:1", (token) => {
		expect(
			contrastRatio(colour(`--hl-${token}`), colour("--color-code-bg")),
		).toBeGreaterThanOrEqual(4.5);
	});

	it.each(
		ansiTextSlots,
	)("ANSI %s on terminal background clears 4.5:1", (slot) => {
		const palette = XTERM_THEMES[variant];
		expect(
			contrastRatio(palette[slot], palette.background),
		).toBeGreaterThanOrEqual(4.5);
	});

	it.each([
		"white",
		"brightWhite",
	] as const)("ANSI %s on terminal background clears 3:1", (slot) => {
		const palette = XTERM_THEMES[variant];
		expect(
			contrastRatio(palette[slot], palette.background),
		).toBeGreaterThanOrEqual(3);
	});
});
