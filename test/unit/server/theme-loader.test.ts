import { describe, expect, it } from "vitest";
import {
	loadThemeFiles,
	validateTheme,
} from "../../../src/lib/server/theme-loader.js";
import { BASE16_KEYS } from "../../../src/lib/shared-types.js";

// ─── validateTheme ──────────────────────────────────────────────────────────

describe("validateTheme", () => {
	const validTheme = {
		name: "Test Theme",
		variant: "dark",
		base00: "1a1a1a",
		base01: "2b2b2b",
		base02: "3c3c3c",
		base03: "4d4d4d",
		base04: "5e5e5e",
		base05: "6f6f6f",
		base06: "808080",
		base07: "919191",
		base08: "e5534b",
		base09: "da7756",
		base0A: "e5a84b",
		base0B: "57ab5a",
		base0C: "4ec9b0",
		base0D: "569cd6",
		base0E: "c586c0",
		base0F: "d7ba7d",
	};

	it("accepts a valid theme", () => {
		expect(validateTheme({ ...validTheme })).toBe(true);
	});

	it("rejects null", () => {
		expect(validateTheme(null)).toBe(false);
	});

	it("rejects undefined", () => {
		expect(validateTheme(undefined)).toBe(false);
	});

	it("rejects non-object", () => {
		expect(validateTheme("string")).toBe(false);
		expect(validateTheme(42)).toBe(false);
	});

	it("rejects object with missing name", () => {
		const { name, ...noName } = validTheme;
		expect(validateTheme(noName)).toBe(false);
	});

	it("rejects object with non-string name", () => {
		expect(validateTheme({ ...validTheme, name: 123 })).toBe(false);
	});

	it("rejects object with missing base16 key", () => {
		const { base0D, ...missing } = validTheme;
		expect(validateTheme(missing)).toBe(false);
	});

	it("rejects invalid hex values (too short)", () => {
		expect(validateTheme({ ...validTheme, base08: "e55" })).toBe(false);
	});

	it("rejects invalid hex values (non-hex chars)", () => {
		expect(validateTheme({ ...validTheme, base08: "zzzzzz" })).toBe(false);
	});

	it("rejects invalid hex values (7 chars)", () => {
		expect(validateTheme({ ...validTheme, base08: "e5534bb" })).toBe(false);
	});

	it("rejects invalid variant value", () => {
		expect(validateTheme({ ...validTheme, variant: "midnight" })).toBe(false);
	});

	it("auto-detects dark variant from base00 luminance", () => {
		const theme = { ...validTheme } as Record<string, unknown>;
		delete theme["variant"];
		// base00 = 1a1a1a → dark
		expect(validateTheme(theme)).toBe(true);
		expect(theme["variant"]).toBe("dark");
	});

	it("auto-detects light variant from base00 luminance", () => {
		const theme = { ...validTheme, base00: "FDF6E3" } as Record<
			string,
			unknown
		>;
		delete theme["variant"];
		// base00 = FDF6E3 → light
		expect(validateTheme(theme)).toBe(true);
		expect(theme["variant"]).toBe("light");
	});

	it("accepts extra unknown keys", () => {
		expect(validateTheme({ ...validTheme, extraField: "foo" })).toBe(true);
	});

	it("rejects hex with leading # character", () => {
		expect(validateTheme({ ...validTheme, base08: "#E5534B" })).toBe(false);
	});

	it("rejects empty string name", () => {
		expect(validateTheme({ ...validTheme, name: "" })).toBe(false);
	});

	it("accepts valid overrides object", () => {
		expect(
			validateTheme({
				...validTheme,
				overrides: { "--color-accent": "#201d1d" },
			}),
		).toBe(true);
	});

	it("rejects overrides with non-string values", () => {
		expect(
			validateTheme({
				...validTheme,
				overrides: { "--color-accent": 123 },
			}),
		).toBe(false);
	});

	it("rejects overrides that is an array", () => {
		expect(
			validateTheme({
				...validTheme,
				overrides: ["--color-accent"],
			}),
		).toBe(false);
	});

	it("accepts theme with no overrides field", () => {
		const { ...noOverrides } = validTheme;
		expect(validateTheme(noOverrides)).toBe(true);
	});
});

// ─── loadThemeFiles ─────────────────────────────────────────────────────────

describe("loadThemeFiles", () => {
	it("loads bundled theme files", async () => {
		const result = await loadThemeFiles();
		expect(result.bundled).toBeDefined();
		expect(Object.keys(result.bundled).length).toBeGreaterThanOrEqual(23);
		expect(result.bundled["claude"]).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.bundled["claude"]!.name).toBe("Claude Dark");
	});

	it("returns empty custom when no custom dir exists", async () => {
		const result = await loadThemeFiles();
		expect(result.custom).toBeDefined();
		expect(typeof result.custom).toBe("object");
	});

	it("validates base16 keys are valid hex", async () => {
		const result = await loadThemeFiles();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const theme = result.bundled["claude"]!;
		for (const key of BASE16_KEYS) {
			expect(theme[key]).toMatch(/^[0-9a-fA-F]{6}$/);
		}
	});

	it("all bundled themes have a variant set", async () => {
		const result = await loadThemeFiles();
		for (const [id, theme] of Object.entries(result.bundled)) {
			expect(
				theme.variant === "dark" || theme.variant === "light",
				`Theme ${id} should have variant 'dark' or 'light', got '${theme.variant}'`,
			).toBe(true);
		}
	});

	it("auto-detects variant when not specified (dark bg = dark)", async () => {
		const result = await loadThemeFiles();
		// Claude theme has base00=2F2E2B (dark background)
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const claude = result.bundled["claude"]!;
		expect(claude.variant).toBe("dark");
	});

	it("loads light themes correctly", async () => {
		const result = await loadThemeFiles();
		// Check at least one light theme exists
		const lightThemes = Object.entries(result.bundled).filter(
			([_, t]) => t.variant === "light",
		);
		expect(lightThemes.length).toBeGreaterThan(0);
	});
});
