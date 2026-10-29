import {
	type CategorySet,
	type SurfacingLevel,
	surfacingLevel,
} from "../../contracts/category-set.js";
import type { MessageSurfacingPreferences } from "../../contracts/message-surfacing.js";
import { assertNever } from "../../utils.js";
import { type ActivityPart, type Turn, turnLog } from "./turns.js";

export type SurfaceLevel = MessageSurfacingPreferences["defaultLevel"];
export type ShowStop = SurfaceLevel | "log";
export type PanelView<Stop extends ShowStop = ShowStop> =
	| { kind: "show"; stop: Stop }
	| { kind: "qa" }
	| { kind: "usage" };
export type StopCounts = Record<Exclude<ShowStop, "final">, number>;
export type Step = Exclude<ActivityPart, { type: "system" }>;

export const SURFACE_LEVELS = ["final", "key", "balanced", "all"] as const;
export const SURFACE_RANK = {
	hidden: 0,
	all: 1,
	balanced: 2,
	key: 3,
	final: 4,
};
export const STOPS = {
	final: {
		short: "Answer",
		menu: "Answer only",
		description: "Just the final message",
	},
	key: {
		short: "Key",
		menu: "Key messages",
		description: "Adds asks and risks",
	},
	balanced: {
		short: "Most",
		menu: "Most messages",
		description: "Adds decisions",
	},
	all: {
		short: "All messages",
		menu: "All messages",
		description: "Adds findings",
	},
	log: {
		short: "Full log",
		menu: "Full log",
		description: "Adds every step, messages in place",
		tab: "Log",
	},
} satisfies Record<
	ShowStop,
	{ short: string; menu: string; description: string; tab?: string }
>;

/** Message verdicts and marks name the stop where the message becomes visible. */
export function stopForLevel(level: SurfacingLevel): ShowStop {
	switch (level) {
		case "hidden":
			return "log";
		case "all":
		case "balanced":
		case "key":
			return level;
		default:
			return assertNever(level);
	}
}

/** Collapsed and Usage have plain dots; Full log surfaces every message stop. */
export function cardLevelFor(view: PanelView | null): SurfaceLevel | null {
	if (view === null) return null;
	switch (view.kind) {
		case "qa":
		case "usage":
			return null;
		case "show": {
			const stop = view.stop;
			switch (stop) {
				case "log":
					return "all";
				case "final":
				case "key":
				case "balanced":
				case "all":
					return stop;
				default:
					return assertNever(stop);
			}
		}
		default:
			return assertNever(view);
	}
}

/** Work and message rows across the Turn; compaction rules are boundaries. */
export function logSteps(turn: Turn): Step[] {
	return turnLog(turn).segment.activity.flatMap((part) =>
		part.type === "system" ? [] : [part],
	);
}

/** A live Turn's newest message, until Jev classifies or a mark places it; every message stop shows it. */
export function pendingMessage(
	parts: readonly ActivityPart[],
	live: boolean,
): ActivityPart | undefined {
	const newest = [...parts].reverse().find((part) => part.type === "assistant");
	return live &&
		newest?.type === "assistant" &&
		newest.surfacingProbabilities === undefined &&
		!newest.surfacingMark
		? newest
		: undefined;
}

export function stopCounts(
	turn: Turn,
	categorySet: CategorySet,
	live = turn.live,
): StopCounts {
	const steps = logSteps(turn);
	const pending = pendingMessage(steps, live);
	const counts: StopCounts = { key: 0, balanced: 0, all: 0, log: steps.length };
	for (const part of steps) {
		if (part.type !== "assistant") continue;
		const { level } = surfacingLevel(
			{ probabilities: part.surfacingProbabilities ?? null },
			categorySet,
			part.surfacingMark ?? undefined,
		);
		for (const stop of ["key", "balanced", "all"] as const) {
			if (part === pending || SURFACE_RANK[level] >= SURFACE_RANK[stop])
				counts[stop]++;
		}
	}
	return counts;
}
