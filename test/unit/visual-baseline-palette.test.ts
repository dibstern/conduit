import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
	type Base16Theme,
	computeTerminalTheme,
	computeVars,
} from "../../src/lib/frontend/stores/theme-compute.js";
import conduitThemeJson from "../../src/lib/themes/conduit.json" with {
	type: "json",
};

const DEFAULT_CHANNEL_TOLERANCE = 2;
const PLATFORMS = ["darwin", "linux"] as const;
const BASELINE_DIRECTORY = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../visual/components.spec.ts-snapshots",
);

interface ExpectedColor {
	value: string;
	source: string;
	tolerance?: number;
}

const conduitTheme = conduitThemeJson as Base16Theme;
const terminalTheme = computeTerminalTheme(conduitTheme);
const themeVars = computeVars(conduitTheme);

function requiredColor(palette: Record<string, string>, key: string): string {
	const value = palette[key];
	if (value === undefined) {
		throw new Error(`Theme computation did not produce ${key}`);
	}
	return value;
}

const STORY_EXPECTATIONS: Record<string, ExpectedColor[]> = {
	"terminal-terminaltab--with-output-desktop": [
		{
			value: requiredColor(terminalTheme, "green"),
			source: "computeTerminalTheme(conduit.json).green (base0B)",
		},
		{
			value: requiredColor(terminalTheme, "background"),
			source: "computeTerminalTheme(conduit.json).background (darkened base00)",
		},
	],
	"ui-menu--default-desktop": [
		{
			value: requiredColor(themeVars, "--color-accent"),
			source: "computeVars(conduit.json)[--color-accent] (base09)",
		},
		{
			value: requiredColor(themeVars, "--color-error"),
			source: "computeVars(conduit.json)[--color-error] (base08)",
			// Darwin's thin menu glyphs reach 3/1/1 from the source RGB at best.
			tolerance: 3,
		},
	],
	"overlays-toast--error-toast-desktop": [
		{
			value: requiredColor(themeVars, "--color-error"),
			source: "computeVars(conduit.json)[--color-error] (base08)",
		},
	],
};

function parseHexColor(color: string): [number, number, number] {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
	if (!match) {
		throw new Error(`Expected a six-digit hex color, received ${color}`);
	}
	return [
		Number.parseInt(match[1] ?? "", 16),
		Number.parseInt(match[2] ?? "", 16),
		Number.parseInt(match[3] ?? "", 16),
	];
}

function containsColor(
	png: PNG,
	expected: string,
	tolerance = DEFAULT_CHANNEL_TOLERANCE,
): boolean {
	const [red, green, blue] = parseHexColor(expected);
	for (let offset = 0; offset < png.data.length; offset += 4) {
		if (
			Math.abs((png.data[offset] ?? 0) - red) <= tolerance &&
			Math.abs((png.data[offset + 1] ?? 0) - green) <= tolerance &&
			Math.abs((png.data[offset + 2] ?? 0) - blue) <= tolerance
		) {
			return true;
		}
	}
	return false;
}

describe("committed Storybook baselines use the source theme palette", () => {
	for (const [story, expectedColors] of Object.entries(STORY_EXPECTATIONS)) {
		for (const platform of PLATFORMS) {
			const filename = `${story}-${platform}.png`;

			it(`${filename} contains its expected palette colors`, () => {
				const baselinePath = resolve(BASELINE_DIRECTORY, filename);
				expect(
					existsSync(baselinePath),
					`${filename}: committed baseline is missing. A deleted or renamed baseline must not silently bypass the palette guard.`,
				).toBe(true);

				const png = PNG.sync.read(readFileSync(baselinePath));
				for (const expected of expectedColors) {
					const tolerance = expected.tolerance ?? DEFAULT_CHANNEL_TOLERANCE;
					expect(
						containsColor(png, expected.value, tolerance),
						`${filename}: expected ${expected.value} from ${expected.source} within ±${tolerance}/255 per channel. The likely cause is a stale baseline needing strict recapture.`,
					).toBe(true);
				}
			});
		}
	}
});
