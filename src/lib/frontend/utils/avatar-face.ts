import type { Avatar, AvatarChoice } from "../../contracts/user-avatar.js";

export const AVATAR_PRESETS = [
	{ id: "fox", label: "Fox", glyph: "🦊", tint: "var(--color-fill-amber)" },
	{
		id: "octopus",
		label: "Octopus",
		glyph: "🐙",
		tint: "var(--color-fill-red)",
	},
	{
		id: "saturn",
		label: "Saturn",
		glyph: "🪐",
		tint: "var(--color-fill-blue)",
	},
	{
		id: "cactus",
		label: "Cactus",
		glyph: "🌵",
		tint: "var(--color-fill-green)",
	},
	{ id: "lemon", label: "Lemon", glyph: "🍋", tint: "var(--color-project-6)" },
	{ id: "whale", label: "Whale", glyph: "🐳", tint: "var(--color-project-5)" },
	{
		id: "orb-violet",
		label: "Violet orb",
		from: "var(--color-fill-blue)",
		to: "var(--color-project-1)",
	},
	{
		id: "orb-sunset",
		label: "Sunset orb",
		from: "var(--color-fill-amber)",
		to: "var(--color-fill-red)",
	},
	{
		id: "orb-ocean",
		label: "Ocean orb",
		from: "var(--color-project-5)",
		to: "var(--color-fill-green)",
	},
	{
		id: "orb-amber",
		label: "Amber orb",
		from: "var(--color-project-6)",
		to: "var(--color-project-2)",
	},
	{
		id: "orb-mint",
		label: "Mint orb",
		from: "var(--color-fill-blue)",
		to: "var(--color-project-3)",
	},
	{
		id: "orb-pink",
		label: "Pink orb",
		from: "var(--color-project-4)",
		to: "var(--color-project-1)",
	},
] as const satisfies readonly ({
	id: Extract<AvatarChoice, { kind: "preset" }>["id"];
	label: string;
} & ({ glyph: string; tint: string } | { from: string; to: string }))[];

type Face =
	| { kind: "letter"; char: string; background: string }
	| { kind: "image"; src: string }
	| { kind: "preset"; glyph: string; background: string }
	| { kind: "shape"; svg: string };

const INKS = [
	"fill-blue",
	"fill-amber",
	"fill-green",
	"fill-red",
	"project-6",
	"project-1",
] as const;

// Integer arithmetic and token colours keep saved seeds portable across browsers.
export function shapeSvg(seed: number): string {
	let value = seed | 0;
	const next = () => {
		value = (value + 0x6d2b79f5) | 0;
		let n = Math.imul(value ^ (value >>> 15), 1 | value);
		n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
		return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
	};
	const index = Math.floor(next() * INKS.length);
	const ink = (offset: number) =>
		`var(--color-${INKS[(index + offset) % INKS.length]})`;
	const x = 8 + Math.floor(next() * 21);
	const y = 8 + Math.floor(next() * 23);
	const angle = Math.floor(next() * 360);
	const dx = Math.floor(next() * 13) - 6;
	const dy = Math.floor(next() * 15) - 7;
	return `<svg viewBox="0 0 36 36" aria-hidden="true"><rect width="36" height="36" fill="${ink(0)}"/><circle cx="${x}" cy="${y}" r="13" fill="${ink(2)}"/><rect x="12" y="12" width="13" height="13" rx="2.5" fill="${ink(4)}" transform="rotate(${angle} 18 18) translate(${dx} ${dy})"/></svg>`;
}

export function face(avatar: Avatar): Face {
	const choice = avatar.choice;
	if (choice?.kind === "mac" && avatar.macPicture)
		return { kind: "image", src: avatar.macPicture };
	if (choice?.kind === "shape")
		return { kind: "shape", svg: shapeSvg(choice.seed) };
	if (choice?.kind === "preset") {
		const preset = AVATAR_PRESETS.find(({ id }) => id === choice.id);
		if (preset)
			return "glyph" in preset
				? {
						kind: "preset",
						glyph: preset.glyph,
						background: `color-mix(in srgb, ${preset.tint} 24%, transparent)`,
					}
				: {
						kind: "preset",
						glyph: "",
						background: `radial-gradient(circle at 30% 25%, rgb(255 255 255 / .42), transparent 55%), linear-gradient(135deg, ${preset.from}, ${preset.to})`,
					};
	}
	// No name until the daemon answers: draw the orb without a letter.
	const name = avatar.name.trim();
	const first =
		new Intl.Segmenter(undefined, { granularity: "grapheme" })
			.segment(name)
			[Symbol.iterator]()
			.next().value?.segment ?? "";
	return {
		kind: "letter",
		char: first.toUpperCase(),
		background:
			"linear-gradient(135deg, var(--color-avatar-start), var(--color-avatar-end))",
	};
}
