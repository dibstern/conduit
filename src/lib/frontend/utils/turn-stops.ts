import type { SurfacingLevel } from "../../contracts/category-set.js";
import type { MessageSurfacingPreferences } from "../../contracts/message-surfacing.js";
import { assertNever } from "../../utils.js";

export type SurfaceLevel = MessageSurfacingPreferences["defaultLevel"];
export type ShowStop = SurfaceLevel | "log";
export type PanelView<Stop extends ShowStop = ShowStop> =
	| { kind: "show"; stop: Stop }
	| { kind: "usage" };

export const SURFACE_LEVELS = ["final", "key", "balanced", "all"] as const;
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
