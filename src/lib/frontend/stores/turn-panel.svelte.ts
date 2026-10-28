import { untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import type { CategorySet } from "../../contracts/category-set.js";
import type { MessageSurfacingStatus } from "../../contracts/message-surfacing.js";
import { assertNever } from "../../utils.js";
import {
	openAsk,
	SURFACE_LEVELS,
	type SurfaceLevel,
} from "../utils/surface-turn.js";
import {
	type Turn,
	type TurnPhase,
	turnLog,
	turnPhase,
} from "../utils/turns.js";
import {
	makeSurfaceDefault,
	sessionSurfaceLevel,
	setSessionSurfaceLevel,
	touchSurfaceSession,
} from "./message-surfacing.svelte.js";
import { setTurnMinimised, turnMinimised } from "./turn-minimisation.svelte.js";

export type ShowStop = SurfaceLevel | "log";
export type PanelView<Stop extends ShowStop = ShowStop> =
	| { kind: "show"; stop: Stop }
	| { kind: "usage" };
export type TurnPanel<Stop extends ShowStop = ShowStop> =
	| { kind: "collapsed" }
	| { kind: "open"; view: PanelView<Stop> };
type TurnChoice = "level" | "log" | "usage";

// Page-lifetime choices survive remounts and paging, but never go to storage.
const choices = new SvelteMap<
	string,
	{
		settled: TurnChoice | null;
		live: { choice: TurnChoice; segment: number } | null;
	}
>();
const messageStops = [...SURFACE_LEVELS, "log"] as const;
const logStops = ["log"] as const;

interface PanelInput {
	readonly sessionId: string | undefined;
	readonly turn: Turn;
	readonly jev: boolean;
	readonly processing: boolean;
	readonly latestTurn: boolean;
	readonly newestSettledTurn: boolean;
	readonly status: MessageSurfacingStatus;
	readonly categorySet: CategorySet;
}

export interface TurnPanelState<Stop extends ShowStop = ShowStop> {
	readonly phase: TurnPhase;
	readonly stops: [Stop] extends ["log"]
		? typeof logStops
		: typeof messageStops | typeof logStops;
	readonly view: TurnPanel<Stop>;
	readonly saved: SurfaceLevel;
	readonly overridden: boolean;
	open(): void;
	collapse(): void;
	show(stop: Stop): void;
	usage(): void;
	makeDefault(): Promise<void>;
	resetLevel(): void;
}

export function createTurnPanel(
	input: PanelInput & { readonly jev: false },
): TurnPanelState<"log">;
export function createTurnPanel(input: PanelInput): TurnPanelState;
export function createTurnPanel(input: PanelInput): TurnPanelState {
	let plainOpen = $state(false);
	const key = $derived(JSON.stringify([input.sessionId ?? "", input.turn.id]));
	const phase = $derived(
		turnPhase(input.turn, input.processing, input.latestTurn),
	);
	const saved = $derived(
		sessionSurfaceLevel(input.sessionId) ?? input.status.defaultLevel,
	);
	const parts = $derived(turnLog(input.turn).segment.activity);
	const allRead = $derived(
		parts.some((part) => part.type === "assistant") &&
			parts.every(
				(part) => part.type !== "assistant" || part.surfacingRead === true,
			),
	);
	const collapsed = $derived(
		input.jev
			? (turnMinimised(input.sessionId, input.turn.id) ??
					(input.status.turnsOpen === "minimised" ||
						(input.status.turnsOpen === "auto" &&
							phase === "settled" &&
							!input.newestSettledTurn &&
							allRead &&
							!openAsk(parts, input.categorySet, input.latestTurn))))
			: !plainOpen,
	);
	const choice = $derived.by(() => {
		const stored = choices.get(key);
		switch (phase) {
			case "live":
			case "waiting":
				return stored?.live?.segment === input.turn.segments.length - 1
					? stored.live.choice
					: null;
			case "settled":
				return stored?.settled ?? null;
			default:
				return assertNever(phase);
		}
	});
	const view = $derived<TurnPanel>(
		collapsed
			? { kind: "collapsed" }
			: {
					kind: "open",
					view:
						choice === "usage"
							? { kind: "usage" }
							: {
									kind: "show",
									stop: !input.jev || choice === "log" ? "log" : saved,
								},
				},
	);
	function pick(choice: TurnChoice) {
		const previous = choices.get(key) ?? { settled: null, live: null };
		switch (phase) {
			case "live":
			case "waiting":
				choices.set(key, {
					...previous,
					live: { choice, segment: input.turn.segments.length - 1 },
				});
				return;
			case "settled":
				choices.set(key, { ...previous, settled: choice });
				return;
			default:
				assertNever(phase);
		}
	}
	function open() {
		// Working inside an already open Turn leaves Auto in charge.
		if (!collapsed) return;
		if (input.jev) setTurnMinimised(input.sessionId, input.turn.id, false);
		else plainOpen = true;
	}
	$effect(() => {
		const sessionId = input.sessionId;
		if (sessionId && input.jev) untrack(() => touchSurfaceSession(sessionId));
	});
	return {
		get phase() {
			return phase;
		},
		get stops() {
			return input.jev ? messageStops : logStops;
		},
		get view() {
			return view;
		},
		get saved() {
			return saved;
		},
		get overridden() {
			return sessionSurfaceLevel(input.sessionId) !== undefined;
		},
		open,
		collapse() {
			if (input.jev) setTurnMinimised(input.sessionId, input.turn.id, true);
			else plainOpen = false;
		},
		show(stop) {
			if (!input.jev && stop !== "log") return;
			switch (stop) {
				case "log":
					pick("log");
					break;
				case "final":
				case "key":
				case "balanced":
				case "all":
					if (input.sessionId) setSessionSurfaceLevel(input.sessionId, stop);
					pick("level");
					break;
				default:
					assertNever(stop);
			}
			open();
		},
		usage() {
			pick("usage");
			open();
		},
		async makeDefault() {
			if (input.sessionId) await makeSurfaceDefault(input.sessionId, saved);
		},
		resetLevel() {
			if (input.sessionId) setSessionSurfaceLevel(input.sessionId, null);
		},
	};
}
