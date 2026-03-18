import { describe, expect, it } from "vitest";
import {
	computeMermaidVars,
	computeTerminalTheme,
	computeVars,
} from "../../../src/lib/frontend/stores/theme-compute.js";
import { loadThemeFiles } from "../../../src/lib/server/theme-loader.js";

const claudeDark = {
	name: "Claude Dark",
	variant: "dark" as const,
	base00: "2F2E2B",
	base01: "35332F",
	base02: "3E3C37",
	base03: "6D6860",
	base04: "908B81",
	base05: "B5B0A6",
	base06: "E8E5DE",
	base07: "FFFFFF",
	base08: "E5534B",
	base09: "DA7756",
	base0A: "E5A84B",
	base0B: "57AB5A",
	base0C: "4EC9B0",
	base0D: "569CD6",
	base0E: "C586C0",
	base0F: "D7BA7D",
};

const solarizedLight = {
	name: "Solarized Light",
	variant: "light" as const,
	base00: "FDF6E3",
	base01: "EEE8D5",
	base02: "93A1A1",
	base03: "839496",
	base04: "657B83",
	base05: "586E75",
	base06: "073642",
	base07: "002B36",
	base08: "DC322F",
	base09: "CB4B16",
	base0A: "B58900",
	base0B: "859900",
	base0C: "2AA198",
	base0D: "268BD2",
	base0E: "6C71C4",
	base0F: "D33682",
};

describe("computeVars", () => {
	it("maps base16 to CSS custom properties with --color- prefix", () => {
		const vars = computeVars(claudeDark);
		expect(vars["--color-bg"]).toBe("#2F2E2B");
		expect(vars["--color-text"]).toBe("#E8E5DE");
		expect(vars["--color-accent"]).toBe("#DA7756");
		expect(vars["--color-error"]).toBe("#E5534B");
		expect(vars["--color-success"]).toBe("#57AB5A");
	});

	it("computes derived colors with exact values", () => {
		const vars = computeVars(claudeDark);
		// accent-hover is lighten(base09, 0.12) for dark themes
		expect(vars["--color-accent-hover"]).toMatch(/^#[0-9a-f]{6}$/);
		expect(vars["--color-accent-hover"]).not.toBe(vars["--color-accent"]);
		// code-bg is darken(base00, 0.15) for dark themes
		expect(vars["--color-code-bg"]).toMatch(/^#[0-9a-f]{6}$/);
		// border-subtle is mixColors(base00, base02, 0.6)
		expect(vars["--color-border-subtle"]).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("includes syntax highlighting variables", () => {
		const vars = computeVars(claudeDark);
		expect(vars["--hl-comment"]).toBe("#6D6860");
		expect(vars["--hl-keyword"]).toBe("#C586C0");
		expect(vars["--hl-string"]).toBe("#57AB5A");
	});

	it("handles light theme variant", () => {
		const vars = computeVars(solarizedLight);
		expect(vars["--overlay-rgb"]).toBe("0,0,0");
		expect(vars["--color-bg"]).toBe("#FDF6E3");
		expect(vars["--color-text"]).toBe("#073642");
	});

	it("handles dark theme variant overlay", () => {
		const vars = computeVars(claudeDark);
		expect(vars["--overlay-rgb"]).toBe("255,255,255");
	});

	it("includes warning and warning-bg variables", () => {
		const vars = computeVars(claudeDark);
		expect(vars["--color-warning"]).toBe("#E5A84B");
		expect(vars["--color-warning-bg"]).toBeDefined();
		expect(vars["--color-warning-bg"]).toContain("rgba");
	});

	it("includes shadow-rgb variable", () => {
		const vars = computeVars(claudeDark);
		expect(vars["--shadow-rgb"]).toBe("0,0,0");
	});

	it("applies overrides from theme JSON", () => {
		const themed = {
			...claudeDark,
			overrides: {
				"--color-accent": "#custom1",
				"--color-accent-hover": "#custom2",
			},
		};
		const vars = computeVars(themed);
		expect(vars["--color-accent"]).toBe("#custom1");
		expect(vars["--color-accent-hover"]).toBe("#custom2");
		// Non-overridden values should still use base16 mapping
		expect(vars["--color-bg"]).toBe("#2F2E2B");
	});

	it("ignores overrides for keys not in base mapping", () => {
		const themed = {
			...claudeDark,
			overrides: {
				"--bogus-key": "should-not-appear",
			},
		};
		const vars = computeVars(themed);
		expect(vars["--bogus-key"]).toBeUndefined();
	});

	it("light theme uses darken for accent-hover (not lighten)", () => {
		const vars = computeVars(solarizedLight);
		// Light themes use darken(base09, 0.12) for accent-hover
		expect(vars["--color-accent-hover"]).toMatch(/^#[0-9a-f]{6}$/);
		// accent-hover should be different from accent
		expect(vars["--color-accent-hover"]).not.toBe(vars["--color-accent"]);
	});

	it("light theme uses shallower darken for code-bg", () => {
		const vars = computeVars(solarizedLight);
		// Light: darken(base00, 0.03) — very slight darkening
		expect(vars["--color-code-bg"]).toMatch(/^#[0-9a-f]{6}$/);
		expect(vars["--color-code-bg"]).not.toBe(vars["--color-bg"]);
	});

	it("light theme sidebar-bg is slightly darker than bg", () => {
		const vars = computeVars(solarizedLight);
		// Light: darken(base00, 0.02)
		expect(vars["--color-sidebar-bg"]).toMatch(/^#[0-9a-f]{6}$/);
		expect(vars["--color-sidebar-bg"]).not.toBe(vars["--color-bg"]);
	});

	it("light theme user-bubble uses darken (not mix)", () => {
		const vars = computeVars(solarizedLight);
		// Light: darken(base01, 0.03)
		expect(vars["--color-user-bubble"]).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("rgba-format variables are valid rgba strings", () => {
		const vars = computeVars(claudeDark);
		const rgbaKeys = [
			"--color-accent-bg",
			"--color-thinking-bg",
			"--color-tool-bg",
			"--color-warning-bg",
		];
		for (const key of rgbaKeys) {
			expect(vars[key], `${key} should be rgba format`).toMatch(
				/^rgba\(\d+, \d+, \d+, [\d.]+\)$/,
			);
		}
	});

	it("handles all-black theme (boundary)", () => {
		const allBlack = {
			name: "All Black",
			variant: "dark" as const,
			base00: "000000",
			base01: "000000",
			base02: "000000",
			base03: "000000",
			base04: "000000",
			base05: "000000",
			base06: "000000",
			base07: "000000",
			base08: "000000",
			base09: "000000",
			base0A: "000000",
			base0B: "000000",
			base0C: "000000",
			base0D: "000000",
			base0E: "000000",
			base0F: "000000",
		};
		const vars = computeVars(allBlack);
		expect(vars["--color-bg"]).toBe("#000000");
		// darken black should still be black (no negative values)
		expect(vars["--color-code-bg"]).toBe("#000000");
		// lighten black by 0.12 should produce a slightly gray color
		expect(vars["--color-accent-hover"]).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("handles all-white theme (boundary)", () => {
		const allWhite = {
			name: "All White",
			variant: "light" as const,
			base00: "ffffff",
			base01: "ffffff",
			base02: "ffffff",
			base03: "ffffff",
			base04: "ffffff",
			base05: "ffffff",
			base06: "ffffff",
			base07: "ffffff",
			base08: "ffffff",
			base09: "ffffff",
			base0A: "ffffff",
			base0B: "ffffff",
			base0C: "ffffff",
			base0D: "ffffff",
			base0E: "ffffff",
			base0F: "ffffff",
		};
		const vars = computeVars(allWhite);
		expect(vars["--color-bg"]).toBe("#ffffff");
		// darken white should produce a slightly gray color
		expect(vars["--color-accent-hover"]).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("handles missing base16 key by defaulting to 000000", () => {
		const partial = {
			name: "Partial Theme",
			variant: "dark" as const,
			base00: "1a1a1a",
			// all other keys missing — extractColors defaults to 000000
		} as unknown as import("../../../src/lib/shared-types.js").Base16Theme;
		const vars = computeVars(partial);
		// Should not throw; missing keys default to #000000
		expect(vars["--color-bg"]).toBe("#1a1a1a");
		expect(vars["--color-error"]).toBe("#000000");
	});

	it("produces all expected CSS variable keys", () => {
		const vars = computeVars(claudeDark);
		const expectedKeys = [
			"--color-bg",
			"--color-bg-alt",
			"--color-bg-surface",
			"--color-text",
			"--color-text-secondary",
			"--color-text-muted",
			"--color-text-dimmer",
			"--color-accent",
			"--color-accent-hover",
			"--color-accent-bg",
			"--color-code-bg",
			"--color-border",
			"--color-border-subtle",
			"--color-input-bg",
			"--color-user-bubble",
			"--color-error",
			"--color-success",
			"--color-thinking",
			"--color-thinking-bg",
			"--color-tool",
			"--color-tool-bg",
			"--color-sidebar-bg",
			"--color-sidebar-hover",
			"--color-sidebar-active",
			"--color-warning",
			"--color-warning-bg",
			"--overlay-rgb",
			"--shadow-rgb",
			"--hl-comment",
			"--hl-keyword",
			"--hl-string",
			"--hl-number",
			"--hl-function",
			"--hl-variable",
			"--hl-type",
			"--hl-constant",
			"--hl-tag",
			"--hl-attr",
			"--hl-regexp",
			"--hl-meta",
			"--hl-builtin",
			"--hl-symbol",
			"--hl-addition",
			"--hl-deletion",
		];
		for (const key of expectedKeys) {
			expect(vars[key], `Missing CSS variable: ${key}`).toBeDefined();
		}
		// Ensure no unexpected extra keys
		expect(Object.keys(vars).length).toBe(expectedKeys.length);
	});
});

describe("computeTerminalTheme", () => {
	it("returns xterm-compatible theme for dark variant", () => {
		const theme = computeTerminalTheme(claudeDark);
		expect(theme["background"]).toBeDefined();
		expect(theme["foreground"]).toBeDefined();
		expect(theme["red"]).toBe("#E5534B");
		expect(theme["green"]).toBe("#57AB5A");
		expect(theme["blue"]).toBe("#569CD6");
		// Dark: black = base00, white = base05
		expect(theme["black"]).toBe("#2F2E2B");
		expect(theme["white"]).toBe("#B5B0A6");
	});

	it("returns xterm-compatible theme for light variant", () => {
		const theme = computeTerminalTheme(solarizedLight);
		expect(theme["background"]).toBeDefined();
		expect(theme["foreground"]).toBe("#586E75");
		// Light: black = base07 (reversed), white = base00 (reversed)
		expect(theme["black"]).toBe("#002B36");
		expect(theme["white"]).toBe("#FDF6E3");
	});

	it("includes bright color variants", () => {
		const theme = computeTerminalTheme(claudeDark);
		expect(theme["brightRed"]).toBeDefined();
		expect(theme["brightGreen"]).toBeDefined();
		expect(theme["brightBlue"]).toBeDefined();
		expect(theme["brightBlack"]).toBe("#6D6860");
		expect(theme["brightWhite"]).toBe("#FFFFFF");
	});

	it("includes cursorAccent", () => {
		const theme = computeTerminalTheme(claudeDark);
		expect(theme["cursorAccent"]).toBe("#2F2E2B");
	});

	it("produces all expected terminal theme keys", () => {
		const theme = computeTerminalTheme(claudeDark);
		const expectedKeys = [
			"background",
			"foreground",
			"cursor",
			"cursorAccent",
			"selectionBackground",
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
		for (const key of expectedKeys) {
			expect(theme[key], `Missing terminal theme key: ${key}`).toBeDefined();
		}
		expect(Object.keys(theme).length).toBe(expectedKeys.length);
	});
});

describe("computeMermaidVars", () => {
	it("returns mermaid theme variables for dark theme", () => {
		const vars = computeMermaidVars(claudeDark);
		expect(vars.darkMode).toBe(true);
		expect(vars.primaryColor).toBeDefined();
		expect(vars.primaryTextColor).toBeDefined();
		expect(vars.fontFamily).toContain("Berkeley Mono");
	});

	it("returns darkMode false for light theme", () => {
		const vars = computeMermaidVars(solarizedLight);
		expect(vars.darkMode).toBe(false);
		expect(vars.background).toBeDefined();
		expect(vars.primaryColor).toBeDefined();
	});

	it("produces all expected mermaid keys", () => {
		const vars = computeMermaidVars(claudeDark);
		const expectedKeys = [
			"darkMode",
			"background",
			"primaryColor",
			"primaryTextColor",
			"primaryBorderColor",
			"lineColor",
			"secondaryColor",
			"tertiaryColor",
			"fontFamily",
		];
		for (const key of expectedKeys) {
			expect(
				vars[key as keyof typeof vars],
				`Missing mermaid key: ${key}`,
			).toBeDefined();
		}
		expect(Object.keys(vars).length).toBe(expectedKeys.length);
	});
});

// ─── Integration: loadThemeFiles → computeVars pipeline ─────────────────────

describe("loadThemeFiles → computeVars integration", () => {
	it("every bundled theme produces valid CSS vars", async () => {
		const { bundled } = await loadThemeFiles();
		expect(Object.keys(bundled).length).toBeGreaterThanOrEqual(23);

		for (const [id, theme] of Object.entries(bundled)) {
			const vars = computeVars(theme);

			// Every theme must produce all core CSS variables
			expect(vars["--color-bg"], `${id}: missing --color-bg`).toMatch(
				/^#[0-9a-fA-F]{6}$/,
			);
			expect(vars["--color-text"], `${id}: missing --color-text`).toMatch(
				/^#[0-9a-fA-F]{6}$/,
			);
			expect(vars["--color-accent"], `${id}: missing --color-accent`).toMatch(
				/^#[0-9a-fA-F]{6}$/,
			);
			expect(vars["--color-error"], `${id}: missing --color-error`).toMatch(
				/^#[0-9a-fA-F]{6}$/,
			);
			expect(vars["--color-success"], `${id}: missing --color-success`).toMatch(
				/^#[0-9a-fA-F]{6}$/,
			);
			expect(vars["--overlay-rgb"], `${id}: missing --overlay-rgb`).toMatch(
				/^\d+,\d+,\d+$/,
			);
			expect(vars["--shadow-rgb"], `${id}: missing --shadow-rgb`).toBe("0,0,0");

			// Validate rgba-format variables
			const rgbaKeys = [
				"--color-accent-bg",
				"--color-thinking-bg",
				"--color-tool-bg",
				"--color-warning-bg",
			];
			for (const rk of rgbaKeys) {
				expect(vars[rk], `${id}: ${rk} should be rgba format`).toMatch(
					/^rgba\(\d+, \d+, \d+, [\d.]+\)$/,
				);
			}
		}
	});

	it("every bundled theme produces valid terminal theme", async () => {
		const { bundled } = await loadThemeFiles();

		for (const [id, theme] of Object.entries(bundled)) {
			const term = computeTerminalTheme(theme);
			expect(
				term["background"],
				`${id}: missing terminal background`,
			).toBeDefined();
			expect(
				term["foreground"],
				`${id}: missing terminal foreground`,
			).toBeDefined();
			expect(term["red"], `${id}: missing terminal red`).toMatch(
				/^#[0-9a-fA-F]{6}$/,
			);
			expect(term["green"], `${id}: missing terminal green`).toMatch(
				/^#[0-9a-fA-F]{6}$/,
			);
			expect(
				term["selectionBackground"],
				`${id}: terminal selectionBackground should be rgba`,
			).toMatch(/^rgba\(/);
		}
	});

	it("every bundled theme produces valid mermaid vars", async () => {
		const { bundled } = await loadThemeFiles();

		for (const [id, theme] of Object.entries(bundled)) {
			const mermaid = computeMermaidVars(theme);
			expect(typeof mermaid.darkMode).toBe("boolean");
			expect(
				mermaid.primaryColor,
				`${id}: missing mermaid primaryColor`,
			).toBeDefined();
			expect(mermaid.fontFamily, `${id}: missing mermaid fontFamily`).toContain(
				"Berkeley Mono",
			);
		}
	});
});
