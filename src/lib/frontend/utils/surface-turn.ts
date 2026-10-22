import {
	type CategorySet,
	type SurfacingMark,
	surfacingLevel,
} from "../../contracts/category-set.js";
import type { MessageSurfacingPreferences } from "../../contracts/message-surfacing.js";
import type { AssistantMessage } from "../types.js";
import { categoryColour } from "./category-colour.js";
import type { ActivityPart } from "./turns.js";

export type SurfaceLevel = MessageSurfacingPreferences["defaultLevel"];
export type SurfacePart = AssistantMessage & {
	/** Annotation owners supply these; surfacing never writes them. */
	surfacingMark?: SurfacingMark | null;
	surfacingRead?: boolean;
};

export const SURFACE_LEVELS = ["final", "key", "balanced", "all"] as const;
export const SURFACE_LABELS = {
	final: "Final",
	key: "Key",
	balanced: "Balanced",
	all: "All",
	hidden: "the log",
};
const rank = { hidden: 0, all: 1, balanced: 2, key: 3, final: 4 };

export function surfaceTime(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** All display policy for one block. The strip supplies its own scale, including seams. */
export function surfaceTurn(input: {
	parts: readonly ActivityPart[];
	turnParts?: readonly ActivityPart[];
	positions: readonly { left: number; width: number }[];
	categorySet: CategorySet;
	level: SurfaceLevel;
	live: boolean;
	latestTurn: boolean;
	latestBlock?: boolean;
	start: number;
	picked: string | null;
	folded: boolean | null;
	hasRecap?: boolean;
	/** A summary citation can reveal its pin without changing the chosen level. */
	citedOrdinal?: number | null;
}) {
	const newest = [...input.parts]
		.reverse()
		.find((part) => part.type === "assistant");
	const messages = input.parts.flatMap((part, step) => {
		if (part.type !== "assistant") return [];
		const message: SurfacePart = part;
		const pending =
			input.live &&
			part === newest &&
			part.surfacingProbabilities === undefined &&
			!message.surfacingMark;
		const result = surfacingLevel(
			{ probabilities: part.surfacingProbabilities ?? null },
			input.categorySet,
			message.surfacingMark ?? undefined,
		);
		const category = input.categorySet.categories.find(
			({ id }) => id === result.category,
		);
		const position = input.positions[step];
		const time = surfaceTime((part.createdAt ?? input.start) - input.start);
		const number = part.surfacingOrdinal;
		const label = pending ? "Waiting for Jev" : (category?.label ?? "Message");
		return [
			{
				part: message,
				step,
				number,
				time,
				pending,
				...result,
				x: (position?.left ?? 0) + (position?.width ?? 0) / 2,
				label,
				builtinCategory:
					category?.origin === "builtin" ? category.id : undefined,
				glyph: pending ? "…" : (category?.glyph ?? "·"),
				colour: pending ? "var(--color-accent)" : categoryColour(category),
				read: message.surfacingRead,
				name: `${number === undefined ? "Pending" : `#${number}`} ${label}, ${time}${message.surfacingRead === undefined ? "" : message.surfacingRead ? ", read" : ", unread"}`,
			},
		];
	});
	const turnMessages = (input.turnParts ?? input.parts).flatMap((part) => {
		if (part.type !== "assistant") return [];
		const message: SurfacePart = part;
		return [
			{
				part: message,
				...surfacingLevel(
					{ probabilities: part.surfacingProbabilities ?? null },
					input.categorySet,
					message.surfacingMark ?? undefined,
				),
			},
		];
	});
	const visibleAt = (level: SurfaceLevel) =>
		level === "final"
			? []
			: messages.filter(
					(message) => message.pending || rank[message.level] >= rank[level],
				);
	const counts = {
		final: 0,
		key: visibleAt("key").length,
		balanced: visibleAt("balanced").length,
		all: visibleAt("all").length,
	};
	const visible = visibleAt(input.level);
	const picked = messages.find(
		({ part }) =>
			part.uuid === input.picked &&
			(input.live ||
				part.surfacingProbabilities !== undefined ||
				!!part.surfacingMark),
	);
	const short =
		turnMessages.filter(({ level }) => level !== "hidden").length < 4;
	const folded =
		input.folded ??
		(!input.latestTurn ||
			input.latestBlock === false ||
			(!!input.hasRecap && !short));
	const pins =
		input.level === "final"
			? []
			: messages.filter(
					(message) =>
						visible.includes(message) ||
						(!folded && message === picked) ||
						(input.citedOrdinal != null &&
							message.number === input.citedOrdinal),
				);
	const target =
		input.level === "final" || folded
			? null
			: (picked ?? visible.at(-1) ?? null);
	const cardIndex = target ? pins.indexOf(target) : -1;
	const belowLevel =
		target !== null &&
		!target.pending &&
		rank[target.level] < rank[input.level];
	const ask = input.latestTurn
		? [...turnMessages]
				.reverse()
				.find(({ category, level }) => category === "ask" && level !== "hidden")
				?.part
		: null;
	const unread = visible.filter(({ read }) => read === false);
	return {
		nearestPin: (x: number) =>
			input.level === "final"
				? null
				: visible.reduce<(typeof visible)[number] | null>(
						(nearest, pin) =>
							!nearest || Math.abs(pin.x - x) < Math.abs(nearest.x - x)
								? pin
								: nearest,
						null,
					),
		pins,
		citedOrdinal: input.citedOrdinal ?? null,
		messages,
		counts,
		card: target,
		cardIndex,
		folded,
		belowLevel,
		sliderText: target
			? `${target.number === undefined ? "Pending" : `#${target.number}`} ${target.label}, ${target.time}, ${cardIndex + 1} of ${pins.length}`
			: "No message selected",
		cardNote:
			belowLevel && target
				? target.level === "hidden"
					? "Hidden at this level · in the step log"
					: `At ${SURFACE_LABELS[target.level]}, below ${SURFACE_LABELS[input.level]} · opened directly`
				: "",
		openAsk: ask ?? null,
		unreadCount: unread.length,
		// The recap and its bulk action cover the whole turn, including hand-backs.
		unreadPartIds: turnMessages.flatMap(({ part, level }) =>
			part.surfacingRead === false &&
			part.partId &&
			(rank[level] >= rank[input.level] ||
				visible.some((pin) => pin.pending && pin.part === part))
				? [part.partId]
				: [],
		),
		hasReadState: messages.some(({ read }) => read !== undefined),
		nextUnread:
			unread.find((message) => message.step > (target?.step ?? -1)) ??
			unread[0] ??
			null,
		notJudgedCount: messages.filter(
			({ part }) => part.surfacingProbabilities === null,
		).length,
		// Everything a reply reference names, for any message the turn's summary can cite.
		numbers: turnMessages.flatMap(({ part, level, category: id }) => {
			if (part.surfacingOrdinal === undefined) return [];
			const category = input.categorySet.categories.find(
				(candidate) => candidate.id === id,
			);
			return [
				{
					number: part.surfacingOrdinal,
					part,
					level,
					belowLevel: rank[level] < rank[input.level],
					label: category?.label ?? "Message",
					builtinCategory:
						category?.origin === "builtin" ? category.id : undefined,
					glyph: category?.glyph ?? "·",
					colour:
						category?.origin === "builtin"
							? categoryColour(category)
							: undefined,
					time: surfaceTime((part.createdAt ?? input.start) - input.start),
				},
			];
		}),
		following: input.live && input.picked === null,
		previous: pins[cardIndex - 1] ?? null,
		next: pins[cardIndex + 1] ?? null,
		first: pins[0] ?? null,
		last: pins.at(-1) ?? null,
		empty: input.level !== "final" && visible.length === 0,
	};
}

export type SurfaceTurn = ReturnType<typeof surfaceTurn>;
export type SurfacePin = SurfaceTurn["pins"][number];

export interface SurfacePinGroup {
	/** The member the pill names when none of its members is open. */
	leader: SurfacePin;
	/** In strip order. */
	members: SurfacePin[];
	row: 0 | 1;
	/** The first member's strip position (%), where the pill's tick lands. */
	x: number;
	left: number;
	width: number;
	/** The tick's offset inside the pill, in px. */
	tick: number;
}

const URGENCY: Readonly<Record<string, number>> = {
	ask: 0,
	blocked: 1,
	risk: 2,
	scope: 2,
	replan: 3,
	correction: 3,
	decision: 3,
	finding: 4,
	milestone: 4,
};

/**
 * Lays the pins into two rows. The open Ask and the pending pin go first and are
 * never grouped; every other pin, in strip order, takes the first row with room or
 * joins the pill placed before it. A row that still overflows merges its closest
 * groupable neighbours. Density is presentation only: stepping and scrubbing still
 * reach every pin.
 */
export function surfacePinRows(
	view: Pick<SurfaceTurn, "pins" | "openAsk">,
	laneWidth: number,
	phone: boolean,
): SurfacePinGroup[] {
	const width = laneWidth > 0 ? laneWidth : 1000;
	const gap = 10;
	const digit = phone ? 7.2 : 6.6;
	const fixed = (pin: SurfacePin) =>
		pin.pending || pin.part.uuid === view.openAsk?.uuid;
	// A Blocked always leads; otherwise the most urgent, then the latest.
	const rank = (pin: SurfacePin) =>
		pin.category === "blocked" ? -1 : (URGENCY[pin.category ?? ""] ?? 5);
	const pill = (members: SurfacePin[], row: 0 | 1, x: number) => {
		// Sized for the widest member, so the pill keeps its width as the open member changes.
		const pillWidth =
			Math.max(
				...members.map(
					(pin) =>
						(phone ? 26 : 22) +
						String(pin.number ?? "").length * digit +
						(pin.part.surfacingMark ? 8 : 0),
				),
			) +
			(members.length > 1 ? 6 + `+${members.length - 1}`.length * digit : 0);
		const leader = members.reduce((best, pin) =>
			(rank(pin) - rank(best) || best.step - pin.step) < 0 ? pin : best,
		);
		return {
			leader,
			members: [...members].sort((a, b) => a.step - b.step),
			row,
			x,
			width: pillWidth,
			left: Math.min(
				Math.max((x / 100) * width - pillWidth / 2, 0),
				width - pillWidth,
			),
			tick: 0,
		};
	};
	const clear = (a: SurfacePinGroup, b: SurfacePinGroup) =>
		a.left + a.width + gap <= b.left || b.left + b.width + gap <= a.left;

	const groups: SurfacePinGroup[] = [];
	let host: SurfacePinGroup | undefined;
	for (const pin of [
		...view.pins.filter(fixed),
		...view.pins.filter((pin) => !fixed(pin)),
	]) {
		const chip = pill([pin], 0, pin.x);
		const row = ([0, 1] as const).find((r) =>
			groups.every((group) => group.row !== r || clear(group, chip)),
		);
		if (row === undefined && host && !fixed(pin)) {
			Object.assign(host, pill([...host.members, pin], host.row, host.x));
			continue;
		}
		const placed = { ...chip, row: row ?? 1 };
		groups.push(placed);
		if (!fixed(pin)) host = placed;
	}

	for (const row of [0, 1] as const) {
		for (;;) {
			const items = groups
				.filter((group) => group.row === row)
				.sort((a, b) => a.x - b.x);
			// Push overlapping pills right, then back inside the lane's right edge.
			let edge = 0;
			for (const group of items) {
				group.left = Math.max(pill(group.members, row, group.x).left, edge);
				edge = group.left + group.width + gap;
			}
			edge = width + gap;
			for (const group of [...items].reverse()) {
				group.left = Math.min(group.left, edge - gap - group.width);
				edge = group.left;
			}
			if ((items[0]?.left ?? 0) >= 0) break;
			const closest = items
				.slice(1)
				.map((group, index) => [items[index], group] as const)
				.filter(
					(pair): pair is readonly [SurfacePinGroup, SurfacePinGroup] =>
						!!pair[0] && !fixed(pair[0].leader) && !fixed(pair[1].leader),
				)
				.sort(([a, b], [c, d]) => b.x - a.x - (d.x - c.x))[0];
			// Only protected pins are left to merge; let them overlap rather than hide one.
			if (!closest) break;
			const [first, second] = closest;
			Object.assign(
				first,
				pill([...first.members, ...second.members], row, first.x),
			);
			groups.splice(groups.indexOf(second), 1);
		}
	}
	for (const group of groups)
		group.tick = Math.min(
			Math.max((group.x / 100) * width - group.left, 9),
			group.width - 9,
		);
	return groups.sort((a, b) => a.x - b.x || a.row - b.row);
}
