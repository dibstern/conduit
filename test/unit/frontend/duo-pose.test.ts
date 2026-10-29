// The Duo pose decides which layout every pose ticket draws, and a wrong pose
// is worse than none: none falls back to today's phone or desktop layout. Rows
// come from the on-device probe (iOS 27, standalone, dpr 3) and from the ways
// this can go wrong:
//
// 1. A landscape iPhone's symmetric notch insets read as the Duo strip.
// 2. The Duo in a Safari tab (not standalone) gets a Duo pose.
// 3. Fractional insets (83.5, 84.33 at dpr 3) miss an exact-match check.
// 4. An iPad portrait split view (600-767 wide, top ~24) reads as unfolded portrait.
// 5. A transient rotation frame pairs one pose's size with another's insets.
// 6. A future iOS changes the inset values: null, never a wrong pose.
// 7. A zero-inset frame before env() resolves: null, then the pose on the next measure.

import { describe, expect, it } from "vitest";
import {
	classifyDuoPose,
	type DuoPose,
	type PoseInput,
} from "../../../src/lib/frontend/utils/duo-pose.js";

const STRIP = { top: 0, right: 84, bottom: 34, left: 0 };
const TOP_STATUS = { top: 61, right: 0, bottom: 34, left: 0 };

const duo = (
	width: number,
	height: number,
	insets: Partial<PoseInput["insets"]> = {},
	base: PoseInput["insets"] = STRIP,
): PoseInput => ({
	width,
	height,
	standalone: true,
	insets: { ...base, ...insets },
});
const foldedPortrait = (insets?: Partial<PoseInput["insets"]>) =>
	duo(466, 657, insets);
const unfoldedPortrait = (width = 669, insets?: Partial<PoseInput["insets"]>) =>
	duo(width, 930, insets, TOP_STATUS);

describe("classifyDuoPose", () => {
	it.each<[string, PoseInput, DuoPose | null]>([
		// The four measured poses.
		["folded portrait", foldedPortrait(), "duo-folded-portrait"],
		["folded landscape", duo(678, 445), "duo-folded-landscape"],
		["unfolded landscape", duo(951, 648), "duo-unfolded-landscape"],
		["unfolded portrait", unfoldedPortrait(), "duo-unfolded-portrait"],

		// 1. Landscape iPhones: symmetric notch insets.
		[
			"landscape iPhone 16 Pro",
			duo(874, 402, { right: 62, left: 62, bottom: 21 }),
			null,
		],
		[
			"landscape iPhone with 59pt sides",
			duo(852, 393, { right: 59, left: 59, bottom: 21 }),
			null,
		],
		[
			"landscape iPhone at Duo width with an 84pt strip on both sides",
			duo(678, 445, { left: 84 }),
			null,
		],

		// 2. Safari tab.
		[
			"folded portrait in a Safari tab",
			{ ...foldedPortrait(), standalone: false },
			null,
		],
		[
			"unfolded portrait in a Safari tab",
			{ ...unfoldedPortrait(), standalone: false },
			null,
		],

		// 3. Fractional insets at dpr 3.
		["right 83.5", foldedPortrait({ right: 83.5 }), "duo-folded-portrait"],
		["right 84.33", duo(951, 648, { right: 84.33 }), "duo-unfolded-landscape"],
		[
			"top 60.67",
			unfoldedPortrait(669, { top: 60.67 }),
			"duo-unfolded-portrait",
		],

		// 4. iPad portrait split view.
		["iPad split view, top 24", duo(694, 1024, { top: 24 }, TOP_STATUS), null],
		[
			"iPad split view, no top inset",
			duo(678, 1024, { top: 0 }, TOP_STATUS),
			null,
		],

		// 5. Transient rotation frames.
		[
			"landscape size, unfolded-portrait insets",
			duo(951, 648, {}, TOP_STATUS),
			null,
		],
		["unfolded-portrait size, strip insets", duo(669, 930), null],
		[
			"square frame mid-rotation at folded width",
			duo(466, 466),
			"duo-folded-portrait",
		],

		// 6. A future iOS changes the values.
		["strip grows to 100", foldedPortrait({ right: 100 }), null],
		["strip shrinks to 60", foldedPortrait({ right: 60 }), null],
		["status inset grows to 80", unfoldedPortrait(669, { top: 80 }), null],
		["strip moves to the left", duo(678, 445, { right: 0, left: 84 }), null],

		// 7. Zero insets before env() resolves, then the next measure.
		[
			"folded portrait before env() resolves",
			foldedPortrait({ right: 0, bottom: 0 }),
			null,
		],
		[
			"unfolded portrait before env() resolves",
			unfoldedPortrait(669, { top: 0, bottom: 0 }),
			null,
		],
		[
			"folded portrait once env() resolves",
			foldedPortrait(),
			"duo-folded-portrait",
		],

		// Boundaries: the strip's right inset, 76 to 92 inclusive.
		["right 75.9", foldedPortrait({ right: 75.9 }), null],
		["right 76", foldedPortrait({ right: 76 }), "duo-folded-portrait"],
		["right 92", foldedPortrait({ right: 92 }), "duo-folded-portrait"],
		["right 92.1", foldedPortrait({ right: 92.1 }), null],

		// Boundaries: the strip's left inset stays below 8.
		["strip, left 7.9", foldedPortrait({ left: 7.9 }), "duo-folded-portrait"],
		["strip, left 8", foldedPortrait({ left: 8 }), null],

		// Boundaries: folded portrait is narrower than 600.
		["portrait strip at 599", duo(599, 930), "duo-folded-portrait"],
		["portrait strip at 600", duo(600, 930), null],

		// Boundaries: folded landscape is narrower than 768.
		["landscape strip at 767", duo(767, 445), "duo-folded-landscape"],
		["landscape strip at 768", duo(768, 445), "duo-unfolded-landscape"],

		// Boundaries: unfolded portrait's top inset, 55 to 67 inclusive.
		["top 54.9", unfoldedPortrait(669, { top: 54.9 }), null],
		["top 55", unfoldedPortrait(669, { top: 55 }), "duo-unfolded-portrait"],
		["top 67", unfoldedPortrait(669, { top: 67 }), "duo-unfolded-portrait"],
		["top 67.1", unfoldedPortrait(669, { top: 67.1 }), null],

		// Boundaries: unfolded portrait is 600 to 767 wide.
		["unfolded portrait at 599", unfoldedPortrait(599), null],
		[
			"unfolded portrait at 600",
			unfoldedPortrait(600),
			"duo-unfolded-portrait",
		],
		[
			"unfolded portrait at 767",
			unfoldedPortrait(767),
			"duo-unfolded-portrait",
		],
		["unfolded portrait at 768", unfoldedPortrait(768), null],

		// Boundaries: unfolded portrait has no side insets.
		[
			"top status, right 7.9",
			unfoldedPortrait(669, { right: 7.9 }),
			"duo-unfolded-portrait",
		],
		["top status, right 8", unfoldedPortrait(669, { right: 8 }), null],
		[
			"top status, left 7.9",
			unfoldedPortrait(669, { left: 7.9 }),
			"duo-unfolded-portrait",
		],
		["top status, left 8", unfoldedPortrait(669, { left: 8 }), null],

		// Boundaries: unfolded portrait must be portrait.
		["top status in landscape", duo(767, 600, {}, TOP_STATUS), null],
	])("%s", (_label, input, expected) => {
		expect(classifyDuoPose(input)).toBe(expected);
	});
});
