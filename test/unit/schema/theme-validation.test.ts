import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Base16ThemeSchema } from "../../../src/lib/server/theme-loader.js";

describe("Theme validation schema", () => {
	it("decodes valid Base16 theme", () => {
		const theme = {
			name: "Test Theme",
			base00: "000000",
			base01: "111111",
			base02: "222222",
			base03: "333333",
			base04: "444444",
			base05: "555555",
			base06: "666666",
			base07: "777777",
			base08: "888888",
			base09: "999999",
			base0A: "aaaaaa",
			base0B: "bbbbbb",
			base0C: "cccccc",
			base0D: "dddddd",
			base0E: "eeeeee",
			base0F: "ffffff",
		};
		const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects theme with invalid hex color", () => {
		const theme = {
			name: "Bad",
			base00: "not-hex",
			base01: "111111",
			base02: "222222",
			base03: "333333",
			base04: "444444",
			base05: "555555",
			base06: "666666",
			base07: "777777",
			base08: "888888",
			base09: "999999",
			base0A: "aaaaaa",
			base0B: "bbbbbb",
			base0C: "cccccc",
			base0D: "dddddd",
			base0E: "eeeeee",
			base0F: "ffffff",
		};
		const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects theme missing required fields", () => {
		const theme = { name: "Incomplete" };
		const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("auto-detects dark variant from base00 luminance", () => {
		const theme = {
			name: "Dark Theme",
			base00: "1a1a1a",
			base01: "111111",
			base02: "222222",
			base03: "333333",
			base04: "444444",
			base05: "555555",
			base06: "666666",
			base07: "777777",
			base08: "888888",
			base09: "999999",
			base0A: "aaaaaa",
			base0B: "bbbbbb",
			base0C: "cccccc",
			base0D: "dddddd",
			base0E: "eeeeee",
			base0F: "ffffff",
		};
		const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.variant).toBe("dark");
		}
	});

	it("auto-detects light variant from base00 luminance", () => {
		const theme = {
			name: "Light Theme",
			base00: "FDF6E3",
			base01: "111111",
			base02: "222222",
			base03: "333333",
			base04: "444444",
			base05: "555555",
			base06: "666666",
			base07: "777777",
			base08: "888888",
			base09: "999999",
			base0A: "aaaaaa",
			base0B: "bbbbbb",
			base0C: "cccccc",
			base0D: "dddddd",
			base0E: "eeeeee",
			base0F: "ffffff",
		};
		const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.variant).toBe("light");
		}
	});

	it("preserves explicit variant when provided", () => {
		const theme = {
			name: "Explicit Dark",
			variant: "dark",
			base00: "FDF6E3",
			base01: "111111",
			base02: "222222",
			base03: "333333",
			base04: "444444",
			base05: "555555",
			base06: "666666",
			base07: "777777",
			base08: "888888",
			base09: "999999",
			base0A: "aaaaaa",
			base0B: "bbbbbb",
			base0C: "cccccc",
			base0D: "dddddd",
			base0E: "eeeeee",
			base0F: "ffffff",
		};
		const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.variant).toBe("dark");
		}
	});

	it("rejects invalid variant value", () => {
		const theme = {
			name: "Bad Variant",
			variant: "midnight",
			base00: "000000",
			base01: "111111",
			base02: "222222",
			base03: "333333",
			base04: "444444",
			base05: "555555",
			base06: "666666",
			base07: "777777",
			base08: "888888",
			base09: "999999",
			base0A: "aaaaaa",
			base0B: "bbbbbb",
			base0C: "cccccc",
			base0D: "dddddd",
			base0E: "eeeeee",
			base0F: "ffffff",
		};
		const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("accepts valid overrides object", () => {
		const theme = {
			name: "With Overrides",
			base00: "000000",
			base01: "111111",
			base02: "222222",
			base03: "333333",
			base04: "444444",
			base05: "555555",
			base06: "666666",
			base07: "777777",
			base08: "888888",
			base09: "999999",
			base0A: "aaaaaa",
			base0B: "bbbbbb",
			base0C: "cccccc",
			base0D: "dddddd",
			base0E: "eeeeee",
			base0F: "ffffff",
			overrides: { "--color-accent": "#201d1d" },
		};
		const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects hex with # prefix", () => {
		const theme = {
			name: "Hash Prefix",
			base00: "#000000",
			base01: "111111",
			base02: "222222",
			base03: "333333",
			base04: "444444",
			base05: "555555",
			base06: "666666",
			base07: "777777",
			base08: "888888",
			base09: "999999",
			base0A: "aaaaaa",
			base0B: "bbbbbb",
			base0C: "cccccc",
			base0D: "dddddd",
			base0E: "eeeeee",
			base0F: "ffffff",
		};
		const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
		expect(Either.isLeft(result)).toBe(true);
	});
});
