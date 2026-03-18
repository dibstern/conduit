import { describe, expect, it } from "vitest";
import {
	darken,
	hexToRgb,
	hexToRgba,
	lighten,
	luminance,
	mixColors,
	rgbToHex,
} from "../../../src/lib/frontend/utils/color.js";

describe("color utilities", () => {
	describe("hexToRgb", () => {
		it("converts hex with hash to RGB", () => {
			expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
		});
		it("converts hex without hash to RGB", () => {
			expect(hexToRgb("2F2E2B")).toEqual({ r: 47, g: 46, b: 43 });
		});
		it("handles short-ish or malformed hex gracefully", () => {
			// 3-char hex won't work correctly (not supported), but shouldn't throw
			const result = hexToRgb("abc");
			expect(result).toBeDefined();
			expect(typeof result.r).toBe("number");
		});
		it("handles empty string without throwing", () => {
			const result = hexToRgb("");
			expect(result).toEqual({ r: 0, g: 0, b: 0 });
		});
	});

	describe("rgbToHex", () => {
		it("converts RGB to hex", () => {
			expect(rgbToHex(255, 0, 0)).toBe("#ff0000");
		});
		it("clamps out-of-range values", () => {
			expect(rgbToHex(300, -10, 128)).toBe("#ff0080");
		});
		it("rounds fractional values", () => {
			expect(rgbToHex(127.6, 0.4, 255)).toBe("#8000ff");
		});
	});

	describe("darken", () => {
		it("reduces brightness", () => {
			expect(darken("#ffffff", 0.5)).toBe("#808080");
		});
		it("darken by 0 returns same color", () => {
			expect(darken("#ff0000", 0)).toBe("#ff0000");
		});
		it("darken by 1 returns black", () => {
			expect(darken("#ff8800", 1)).toBe("#000000");
		});
	});

	describe("lighten", () => {
		it("increases brightness", () => {
			expect(lighten("#000000", 0.5)).toBe("#808080");
		});
		it("lighten by 0 returns same color", () => {
			expect(lighten("#ff0000", 0)).toBe("#ff0000");
		});
		it("lighten by 1 returns white", () => {
			expect(lighten("#003366", 1)).toBe("#ffffff");
		});
	});

	describe("hexToRgba", () => {
		it("creates rgba string", () => {
			expect(hexToRgba("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
		});
		it("handles alpha 0 and 1", () => {
			expect(hexToRgba("#000000", 0)).toBe("rgba(0, 0, 0, 0)");
			expect(hexToRgba("#ffffff", 1)).toBe("rgba(255, 255, 255, 1)");
		});
	});

	describe("mixColors", () => {
		it("blends two colors at 50/50", () => {
			expect(mixColors("#ffffff", "#000000", 0.5)).toBe("#808080");
		});
		it("weight 1 returns first color", () => {
			expect(mixColors("#ff0000", "#0000ff", 1)).toBe("#ff0000");
		});
		it("weight 0 returns second color", () => {
			expect(mixColors("#ff0000", "#0000ff", 0)).toBe("#0000ff");
		});
	});

	describe("luminance", () => {
		it("black returns ~0", () => {
			expect(luminance("#000000")).toBeCloseTo(0, 1);
		});
		it("white returns ~1", () => {
			expect(luminance("#ffffff")).toBeCloseTo(1, 1);
		});
		it("returns value between 0 and 1", () => {
			const l = luminance("#808080");
			expect(l).toBeGreaterThan(0);
			expect(l).toBeLessThan(1);
		});
	});
});
