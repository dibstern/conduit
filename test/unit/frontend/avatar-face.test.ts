import { describe, expect, it } from "vitest";
import type { Avatar } from "../../../src/lib/contracts/user-avatar.js";
import { face, shapeSvg } from "../../../src/lib/frontend/utils/avatar-face.js";

// Failure modes: Unicode initials split, missing Mac pictures leave broken images,
// presets disappear, or a seed renders differently between devices/themes.
const avatar: Avatar = { choice: null, name: "David", macPicture: null };

describe("avatar rendering", () => {
	it.each([
		[" david", "D"],
		["éloïse", "É"],
		["👩🏽‍💻 Coder", "👩🏽‍💻"],
		["", ""],
	])("draws the first grapheme of %j", (name, char) => {
		expect(face({ ...avatar, name })).toMatchObject({ kind: "letter", char });
	});
	it("falls back to the initial when the stored Mac picture is unavailable", () => {
		expect(face({ ...avatar, choice: { kind: "mac" } })).toEqual(face(avatar));
		const src = "data:image/jpeg;base64,cGljdHVyZQ==";
		expect(
			face({ ...avatar, choice: { kind: "mac" }, macPicture: src }),
		).toEqual({ kind: "image", src });
	});
	it("keeps every built-in preset drawable", () => {
		for (const id of [
			"fox",
			"octopus",
			"saturn",
			"cactus",
			"lemon",
			"whale",
			"orb-violet",
			"orb-sunset",
			"orb-ocean",
			"orb-amber",
			"orb-mint",
			"orb-pink",
		] as const) {
			expect(face({ ...avatar, choice: { kind: "preset", id } }).kind).toBe(
				"preset",
			);
		}
	});
	it("renders stable, distinct shapes using theme tokens for fixed seeds", () => {
		const shapes = Array.from({ length: 12 }, (_, seed) => shapeSvg(seed));
		expect(new Set(shapes).size).toBe(12);
		for (const [seed, svg] of shapes.entries()) {
			expect(shapeSvg(seed)).toBe(svg);
			expect(svg).toContain("var(--color-");
			expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b|<script|NaN/);
			expect(face({ ...avatar, choice: { kind: "shape", seed } })).toEqual({
				kind: "shape",
				svg,
			});
		}
		expect(shapeSvg(-2147483648)).not.toBe(shapeSvg(2147483647));
	});
});
