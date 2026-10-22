import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_CATEGORIES } from "../../../src/lib/contracts/category-set.js";
import { XTERM_THEMES } from "../../../src/lib/frontend/utils/xterm-themes.js";

const style = readFileSync(
	new URL("../../../src/lib/frontend/style.css", import.meta.url),
	"utf8",
);
const darkTheme = Array.from(
	style.matchAll(/@theme(?:\s+static)?\s*\{([^}]+)\}/g),
	(match) => match[1],
).join("\n");
const surfaces = [
	"bg",
	"bg-surface",
	"bg-alt",
	"bg-raised",
	"popover-bg",
	"selection",
	"settings-bg",
	"settings-card",
	"settings-segment",
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

type Lab = readonly [lightness: number, a: number, b: number];

function labD65(hex: string): Lab {
	const [r, g, b] = rgb(hex).map((channel) => {
		const s = channel / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	// sRGB's D65 white stays unadapted: CSS lab() would instead use D50.
	const f = (value: number) =>
		value > (6 / 29) ** 3
			? Math.cbrt(value)
			: value / (3 * (6 / 29) ** 2) + 4 / 29;
	const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
	const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
	const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
	return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

// Sharma, Wu and Dalal's reference formula, with kL = kC = kH = 1:
// https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/dataNprograms/deltaE2000.m
function deltaE2000([l1, a1, b1]: Lab, [l2, a2, b2]: Lab): number {
	const meanChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
	const g =
		0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + 25 ** 7)));
	const aPrime1 = (1 + g) * a1;
	const aPrime2 = (1 + g) * a2;
	const c1 = Math.hypot(aPrime1, b1);
	const c2 = Math.hypot(aPrime2, b2);
	const tau = 2 * Math.PI;
	const h1 = (Math.atan2(b1, aPrime1) + tau) % tau;
	const h2 = (Math.atan2(b2, aPrime2) + tau) % tau;
	const hueDifference = h2 - h1;
	const deltaHue =
		c1 * c2 === 0
			? 0
			: hueDifference > Math.PI
				? hueDifference - tau
				: hueDifference < -Math.PI
					? hueDifference + tau
					: hueDifference;
	let meanHue = (h1 + h2) / 2;
	if (Math.abs(hueDifference) > Math.PI) meanHue -= Math.PI;
	if (meanHue < 0) meanHue += tau;
	if (c1 * c2 === 0) meanHue = h1 + h2;
	const meanLightness = (l1 + l2) / 2;
	const meanC = (c1 + c2) / 2;
	const lightnessOffset = (meanLightness - 50) ** 2;
	const sL = 1 + (0.015 * lightnessOffset) / Math.sqrt(20 + lightnessOffset);
	const sC = 1 + 0.045 * meanC;
	const t =
		1 -
		0.17 * Math.cos(meanHue - Math.PI / 6) +
		0.24 * Math.cos(2 * meanHue) +
		0.32 * Math.cos(3 * meanHue + Math.PI / 30) -
		0.2 * Math.cos(4 * meanHue - (63 * Math.PI) / 180);
	const sH = 1 + 0.015 * meanC * t;
	const rotation =
		-Math.sin(
			(Math.PI / 3) *
				Math.exp(-((((meanHue * 180) / Math.PI - 275) / 25) ** 2)),
		) *
		2 *
		Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7));
	const dL = (l2 - l1) / sL;
	const dC = (c2 - c1) / sC;
	const dH = (2 * Math.sqrt(c1 * c2) * Math.sin(deltaHue / 2)) / sH;
	return Math.sqrt(dL ** 2 + dC ** 2 + dH ** 2 + rotation * dC * dH);
}

// Published reference pairs cover the blue rotation, zero chroma and hue wrap.
// https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/dataNprograms/ciede2000testdata.txt
it.each([
	[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
	[[50, 0, 0], [50, -1, 2], 2.3669],
	[[50, -1, 2], [50, 0, 0], 2.3669],
	[[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
	[[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
	[[50, 2.5, 0], [73, 25, -18], 27.1492],
] as const)("CIEDE2000 reference %j to %j is %s", (first, second, expected) => {
	expect(deltaE2000(first, second)).toBeCloseTo(expected, 4);
});

describe.each(["dark", "light"] as const)("%s theme contrast", (variant) => {
	const block =
		variant === "dark"
			? darkTheme
			: /:root\.light-theme\s*\{([^}]+)\}/.exec(style)?.[1];
	if (!block)
		throw new Error(`style.css is missing the ${variant} theme block`);
	const tokens = Object.fromEntries(
		// Account identity fills inherit from @theme in the light theme, as in CSS.
		Array.from(
			(darkTheme + block).matchAll(/(--[\w-]+):\s*([^;]+);/g),
			(match) => [match[1], match[2]?.trim()],
		),
	);
	function colour(token: string): string {
		const property = token.startsWith("--") ? token : `--color-${token}`;
		const value = tokens[property];
		if (value === undefined) throw new Error(`${variant} is missing ${token}`);
		const alias = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
		return alias ? colour(alias) : value;
	}

	it.each(
		BUILTIN_CATEGORIES.map(({ id }) => id),
	)("%s category ink on its 14%% tint clears the quiet-tier 3:1 floor", (id) => {
		const ink = colour(`cat-${id}`);
		for (const base of ["settings-card", "turn-bg"]) {
			expect(
				contrastRatio(ink, composite(ink, colour(base), 0.14)),
				base,
			).toBeGreaterThanOrEqual(3);
		}
	});

	it.each(
		BUILTIN_CATEGORIES.flatMap(({ id }, index) =>
			BUILTIN_CATEGORIES.slice(index + 1).map(
				(other) => [id, other.id] as const,
			),
		),
	)("%s and %s categories differ by at least 12 CIEDE2000", (first, second) => {
		expect(
			deltaE2000(
				labD65(colour(`cat-${first}`)),
				labD65(colour(`cat-${second}`)),
			),
		).toBeGreaterThanOrEqual(12);
	});

	it("primary capsule ink on accent-bg over chip clears 4.5:1", () => {
		const capsule = composite(colour("chip"), colour("bg"));
		expect(
			contrastRatio(colour("accent"), composite(colour("accent-bg"), capsule)),
		).toBeGreaterThanOrEqual(4.5);
	});

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
		["on-fill-ask", "fill-ask", 1, "bg"],
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
		// Desktop header state chips and the goal card's tag and Clear goal.
		["status-snoozed", "status-snoozed", 0.15, "bg"],
		["status-pinned", "status-pinned", 0.12, "bg"],
		["status-goal", "status-goal", 0.12, "popover-bg"],
		["error", "error", 0.12, "popover-bg"],
		["error", "error", 0.12, "input-bg"],
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
