import {
	type CategorySet,
	type SurfacingMark,
	surfacingLevel,
} from "../../contracts/category-set.js";
import type { MessageSurfacingPreferences } from "../../contracts/message-surfacing.js";
import type { AssistantMessage } from "../types.js";
import type { ActivityPart } from "./turns.js";

export type SurfaceLevel = MessageSurfacingPreferences["defaultLevel"];
export type SurfacePart = AssistantMessage & {
	/** Annotation owners supply these; surfacing never writes them. */
	surfacingMark?: SurfacingMark;
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
			part.surfacingProbabilities === undefined;
		const result = surfacingLevel(
			{ probabilities: part.surfacingProbabilities ?? null },
			input.categorySet,
			message.surfacingMark,
		);
		const category = input.categorySet.categories.find(
			({ id }) => id === result.category,
		);
		const position = input.positions[step];
		const time = surfaceTime((part.createdAt ?? input.start) - input.start);
		const number = part.surfacingOrdinal;
		const label = pending ? "Waiting for Jev" : (category?.label ?? "Message");
		const colours: Readonly<Record<string, string>> = {
			ask: "var(--color-status-ask)",
			blocked: "var(--color-error)",
			risk: "var(--color-status-risk)",
			milestone: "var(--color-success)",
		};
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
				glyph: pending ? "…" : (category?.glyph ?? "·"),
				colour: pending
					? "var(--color-accent)"
					: category?.origin === "custom"
						? category.colour
						: (colours[result.category ?? ""] ?? "var(--color-text-muted)"),
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
					message.surfacingMark,
				),
			},
		];
	});
	const counts = {
		final: 0,
		key: messages.filter((message) => rank[message.level] >= rank.key).length,
		balanced: messages.filter((message) => rank[message.level] >= rank.balanced)
			.length,
		all: messages.filter((message) => rank[message.level] >= rank.all).length,
	};
	const visible = messages.filter(
		(message) => message.pending || rank[message.level] >= rank[input.level],
	);
	const picked = messages.find(
		({ part }) =>
			part.uuid === input.picked &&
			(input.live || part.surfacingProbabilities !== undefined),
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
						visible.includes(message) || (!folded && message === picked),
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
		hasReadState: messages.some(({ read }) => read !== undefined),
		nextUnread:
			unread.find((message) => message.step > (target?.step ?? -1)) ??
			unread[0] ??
			null,
		notJudgedCount: messages.filter(
			({ part }) => part.surfacingProbabilities === null,
		).length,
		numbers: turnMessages.flatMap(({ part, level }) =>
			part.surfacingOrdinal === undefined
				? []
				: [
						{
							number: part.surfacingOrdinal,
							part,
							belowLevel: rank[level] < rank[input.level],
						},
					],
		),
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
