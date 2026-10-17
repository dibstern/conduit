import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { XTERM_THEMES } from "../../../src/lib/frontend/utils/xterm-themes.js";

const style = readFileSync(
	new URL("../../../src/lib/frontend/style.css", import.meta.url),
	"utf8",
);
const surfaces = [
	"bg",
	"bg-surface",
	"bg-alt",
	"bg-raised",
	"popover-bg",
	"selection",
	"settings-bg",
	"settings-card",
	"settings-rail",
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
	"accent",
	"accent-hover",
	"error",
	"success",
	"warning",
	"thinking",
	"tool",
	"status-ask",
	"status-snoozed",
	"status-pinned",
	"status-goal",
	"status-risk",
];
// The quiet tier. The approved design reserves these for text you are not meant
// to read to understand the screen -- timestamps, match counts, keyboard hints,
// code comments -- and its values sit below AA by intent. Held to the 3:1
// large-text floor so they cannot decay to invisible, not to 4.5:1.
const quietTextTokens = ["text-dimmer"];
const quietSyntaxTokens = ["comment"];
const syntaxTokens = [
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
type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb {
	if (!/^#[0-9a-f]{6}$/i.test(hex)) {
		throw new Error(`Expected a six-digit hex colour, received ${hex}`);
	}
	const channel = (offset: number) =>
		Number.parseInt(hex.slice(offset, offset + 2), 16);
	return [channel(1), channel(3), channel(5)];
}

function composite(fill: string, surface: string | Rgb, opacity = 1): Rgb {
	const rgba = /^rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/.exec(
		fill,
	);
	const channels: Rgb = rgba
		? [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])]
		: rgb(fill);
	const alpha = opacity * (rgba ? Number(rgba[4]) : 1);
	const background = typeof surface === "string" ? rgb(surface) : surface;
	// Keep fractional channels: rounding each layer can conceal a failing pair.
	const channel = (index: 0 | 1 | 2) =>
		channels[index] * alpha + background[index] * (1 - alpha);
	return [channel(0), channel(1), channel(2)];
}

function relativeLuminance(colour: string | Rgb): number {
	const channels = typeof colour === "string" ? rgb(colour) : colour;
	const channel = (index: 0 | 1 | 2) => {
		const s = channels[index] / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrastRatio(foreground: string, background: string | Rgb): number {
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
		// Account identity fills inherit from @theme in the light theme, as in CSS.
		Array.from(
			(/@theme\s*\{([^}]+)\}/.exec(style)?.[1] + block).matchAll(
				/(--[\w-]+):\s*([^;]+);/g,
			),
			(match) => [match[1], match[2]?.trim()],
		),
	);
	function colour(token: string): string {
		const property = token.startsWith("--") ? token : `--color-${token}`;
		const value = tokens[property];
		if (value === undefined) throw new Error(`${variant} is missing ${token}`);
		return value;
	}

	// Rendered text/fill/opacity/base combinations, rather than an all-token
	// cross product: quiet ink is not used on every tinted action or banner.
	it.each([
		// Sidebar select header/filter, bulk bar, and DiffView's pill tabs.
		["accent", "accent", 0.2, "bg-surface"],
		["text", "accent", 0.2, "bg-surface"],
		["accent", "accent", 0.14, "bg-surface"],
		["accent", "accent-bg", 1, "bg-surface"],
		["error", "accent-bg", 1, "bg-surface"],
		// QuestionCard options, CommandMenu/FileMenu, Badge and joined settings tabs.
		["text", "accent-bg", 1, "bg-surface"],
		["text-secondary", "accent-bg", 1, "bg-surface"],
		["text-muted", "accent-bg", 1, "bg-surface"],
		["warning", "accent-bg", 1, "bg-surface"],
		["accent", "accent-bg", 1, "settings-bg"],
		// Banners, permission/soft buttons, swipe reveals, setup and settings strips.
		["accent", "accent-bg", 1, "bg"],
		["accent", "accent", 0.2, "bg"],
		["accent", "accent", 0.15, "bg-surface"],
		["success", "success", 0.08, "bg"],
		["success", "success", 0.15, "bg-surface"],
		["success", "success", 0.1, "settings-bg"],
		["error", "error", 0.1, "bg"],
		["error", "error", 0.15, "bg-surface"],
		["status-snoozed", "status-snoozed", 0.15, "bg-surface"],
		["warning", "warning-bg", 1, "bg"],
		["warning", "warning-bg", 1, "user-bubble"],
		["warning", "warning", 0.14, "input-bg"],
		["text", "error", 0.07, "bg"],
		["text-secondary", "error", 0.07, "bg"],
		["error", "error", 0.07, "bg"],
		["text-secondary", "warning", 0.06, "bg"],
		// Composer goal/usage strips and model-control hover fills.
		["status-goal", "status-goal", 0.1, "input-bg"],
		["text-secondary", "status-goal", 0.1, "input-bg"],
		["text-secondary", "status-green", 0.1, "input-bg"],
		["status-green", "status-green", 0.1, "input-bg"],
		["text-muted", "text-muted", 0.1, "input-bg"],
		["status-amber", "status-amber", 0.1, "input-bg"],
		["text-secondary", "status-amber", 0.1, "input-bg"],
		["text-secondary", "text", 0.07, "input-bg"],
		["text", "text", 0.07, "bg-surface"],
		// RunningPill, background task chips/list selection.
		["tool", "tool", 0.07, "bg"],
		["tool", "tool", 0.13, "bg-surface"],
		["text", "tool", 0.13, "bg-surface"],
		["text-muted", "tool", 0.13, "bg-surface"],
		// Diff code and unchanged cells sharing a tinted row.
		["success", "success", 0.08, "code-bg"],
		["error", "error", 0.08, "code-bg"],
		["text-secondary", "success", 0.08, "code-bg"],
		["text-secondary", "error", 0.08, "code-bg"],
	] as const)("%s on %s at %s over %s clears 4.5:1", (text, fill, opacity, base) => {
		expect(
			contrastRatio(
				colour(text),
				composite(colour(fill), colour(base), opacity),
			),
		).toBeGreaterThanOrEqual(4.5);
	});

	it.each([
		"bg",
		"bg-surface",
		"selection",
		"sidebar-hover",
	])("wake pill text over %s clears 4.5:1", (base) => {
		for (const [text, fill, opacity] of [
			["warning", "warning", 0.1],
			["status-ask", "status-ask", 0.1],
			["error", "error", 0.1],
			["success", "success", 0.1],
			["accent", "accent-bg", 1],
		] as const) {
			expect(
				contrastRatio(
					colour(text),
					composite(colour(fill), colour(base), opacity),
				),
				text,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it.each([
		"project-1",
		"project-3",
		"fill-green",
		"fill-blue",
		"fill-amber",
		"project-4",
	])("account card text on %s tint clears 4.5:1", (fill) => {
		for (const text of ["text", "text-muted"]) {
			expect(
				contrastRatio(
					colour(text),
					composite(colour(fill), colour("bg-surface"), 0.1),
				),
				text,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it.each([
		"bg",
		"code-bg",
		"user-bubble",
	])("floating island and translucent copy control over %s clear 4.5:1", (base) => {
		for (const fill of ["glass", "bg-surface"]) {
			expect(
				contrastRatio(
					colour("text-secondary"),
					composite(colour(fill), colour(base), fill === "glass" ? 1 : 0.8),
				),
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it.each([
		"success",
		"error",
	])("split diff %s cell on a changed row clears 4.5:1", (text) => {
		const row = composite(
			`rgba(${colour("--overlay-rgb")}, 0.05)`,
			colour("code-bg"),
		);
		expect(
			contrastRatio(colour(text), composite(colour(text), row, 0.08)),
		).toBeGreaterThanOrEqual(4.5);
	});

	it.each([
		"success",
		"error",
	])("quiet diff numbers on %s tint clear 3:1", (fill) => {
		expect(
			contrastRatio(
				colour("text-dimmer"),
				composite(colour(fill), colour("code-bg"), 0.08),
			),
		).toBeGreaterThanOrEqual(3);
	});

	it.each([
		"bg",
		"bg-surface",
	])("quiet tag text on the overlay wash over %s clears 3:1", (base) => {
		expect(
			contrastRatio(
				colour("text-dimmer"),
				composite(`rgba(${colour("--overlay-rgb")}, 0.05)`, colour(base)),
			),
		).toBeGreaterThanOrEqual(3);
	});

	it.each([
		"text-muted",
		"error",
	])("system-message %s details on the code well clear 4.5:1", (text) => {
		expect(
			contrastRatio(colour(text), colour("code-bg")),
		).toBeGreaterThanOrEqual(4.5);
	});

	it.each([
		"addition",
		"deletion",
	])("syntax %s on its diff tint clears 4.5:1", (text) => {
		const fill = text === "addition" ? "success" : "error";
		expect(
			contrastRatio(
				colour(`--hl-${text}`),
				composite(colour(fill), colour("code-bg"), 0.1),
			),
		).toBeGreaterThanOrEqual(4.5);
	});

	it.each([
		["error", 0.07],
		["warning", 0.06],
	] as const)("quiet usage-limit detail on %s at %s clears 3:1", (fill, opacity) => {
		expect(
			contrastRatio(
				colour("text-dimmer"),
				composite(colour(fill), colour("bg"), opacity),
			),
		).toBeGreaterThanOrEqual(3);
	});

	it("quiet diff numbers on the changed-row wash clear 3:1", () => {
		expect(
			contrastRatio(
				colour("text-dimmer"),
				composite(`rgba(${colour("--overlay-rgb")}, 0.05)`, colour("code-bg")),
			),
		).toBeGreaterThanOrEqual(3);
	});

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
		quietTextTokens.flatMap((token) =>
			surfaces.map((surface) => [token, surface] as const),
		),
	)("quiet %s text on %s clears 3:1", (token, surface) => {
		expect(
			contrastRatio(colour(`--color-${token}`), colour(`--color-${surface}`)),
		).toBeGreaterThanOrEqual(3);
	});

	it.each(
		quietSyntaxTokens,
	)("quiet syntax %s on code-bg clears 3:1", (token) => {
		expect(
			contrastRatio(colour(`--hl-${token}`), colour("--color-code-bg")),
		).toBeGreaterThanOrEqual(3);
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
