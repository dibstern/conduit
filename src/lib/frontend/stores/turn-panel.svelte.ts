import { tick, untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import type { CategorySet } from "../../contracts/category-set.js";
import type { MessageSurfacingStatus } from "../../contracts/message-surfacing.js";
import { assertNever } from "../../utils.js";
import { openAsk } from "../utils/surface-turn.js";
import {
	type PanelView,
	type ShowStop,
	SURFACE_LEVELS,
	type SurfaceLevel,
} from "../utils/turn-stops.js";
import {
	isOpenHandBack,
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
import { pendingQuestionFor } from "./permissions.svelte.js";
import { setTurnMinimised, turnMinimised } from "./turn-minimisation.svelte.js";

export type TurnPanel<Stop extends ShowStop = ShowStop> =
	| { kind: "collapsed" }
	| { kind: "open"; view: PanelView<Stop> };
type TurnChoice = "level" | "log" | "qa" | "usage";

export type TurnTarget =
	| { kind: "message"; uuid: string }
	| { kind: "step"; id: string };
export type PendingReveal = { turnId: string; target: TurnTarget; seq: number };
const pending = new SvelteMap<symbol, PendingReveal>();
const receipts = new Map<number, (result: "landed" | "missing") => void>();
let sequence = 0;

/** A mounted destination, rather than a broadcast or DOM search, proves a landing. */
export async function revealTurnTarget(
	viewId: symbol,
	turnId: string,
	target: TurnTarget,
): Promise<"landed" | "missing"> {
	const previous = pending.get(viewId);
	if (previous) receipts.get(previous.seq)?.("missing");
	const seq = ++sequence;
	const landed = new Promise<"landed" | "missing">((resolve) =>
		receipts.set(seq, resolve),
	);
	pending.set(viewId, { turnId, target, seq });
	void tick().then(async () => {
		for (let frame = 0; frame < 2; frame++)
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
		if (pending.get(viewId)?.seq === seq) pending.delete(viewId);
		receipts.get(seq)?.("missing");
		receipts.delete(seq);
	});
	return landed;
}

/** Svelte action shared by the mounted log row and message card. */
export function landTurnTarget(
	node: HTMLElement,
	input: {
		pending: PendingReveal | null;
		target: TurnTarget;
		ack: (seq: number) => void;
		navigation?: "scroll" | "in-place";
		beforeScroll?: (() => void) | undefined;
	},
) {
	let current = input;
	function land(next: typeof input) {
		current = next;
		if (!next.pending) return;
		const seq = next.pending.seq;
		// Updates can reach a kept log row before its parent loses `hidden`.
		void tick().then(() => {
			const {
				pending,
				target,
				ack,
				navigation = "scroll",
				beforeScroll,
			} = current;
			if (pending?.seq !== seq || !node.isConnected) return;
			let matches: boolean;
			switch (target.kind) {
				case "message":
					matches =
						pending.target.kind === "message" &&
						pending.target.uuid === target.uuid;
					break;
				case "step":
					matches =
						pending.target.kind === "step" && pending.target.id === target.id;
					break;
				default:
					return assertNever(target);
			}
			if (!matches) return;
			if (navigation === "scroll") {
				beforeScroll?.();
				node.scrollIntoView({ block: "nearest" });
				node.focus({ preventScroll: true });
			}
			ack(pending.seq);
		});
	}
	land(input);
	return { update: land };
}

// Page-lifetime choices survive remounts and paging, but never go to storage.
const choices = new SvelteMap<
	string,
	{
		settled: TurnChoice | null;
		live: {
			choice: TurnChoice;
			segment: number;
			phase: "live" | "waiting";
		} | null;
	}
>();
const messageStops = [...SURFACE_LEVELS, "log"] as const;
const logStops = ["log"] as const;

interface PanelInput {
	readonly viewId: symbol;
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
	readonly hasHandBacks: boolean;
	readonly stops: [Stop] extends ["log"]
		? typeof logStops
		: typeof messageStops | typeof logStops;
	readonly view: TurnPanel<Stop>;
	readonly saved: SurfaceLevel;
	readonly overridden: boolean;
	readonly pending: PendingReveal | null;
	readonly target: TurnTarget | null;
	ack(seq: number): void;
	open(): void;
	collapse(): void;
	show(stop: Stop): void;
	usage(): void;
	qa(): void;
	hold(): void;
	makeDefault(): Promise<void>;
	resetLevel(): void;
}

export function createTurnPanel(
	input: PanelInput & { readonly jev: false },
): TurnPanelState<"log">;
export function createTurnPanel(input: PanelInput): TurnPanelState;
export function createTurnPanel(input: PanelInput): TurnPanelState {
	const stops = $derived(input.jev ? messageStops : logStops);
	const key = $derived(JSON.stringify([input.sessionId ?? "", input.turn.id]));
	const reveal = $derived.by(() => {
		const entry = pending.get(input.viewId);
		return entry?.turnId === input.turn.id ? entry : null;
	});
	const revealStop = $derived.by(() => {
		if (!reveal) return null;
		switch (reveal.target.kind) {
			case "message":
				return choice === "log" ? "log" : "level";
			case "step":
				return "log";
			default:
				return assertNever(reveal.target);
		}
	});
	const phase = $derived(
		turnPhase(input.turn, input.processing, input.latestTurn),
	);
	const saved = $derived(
		sessionSurfaceLevel(input.sessionId) ?? input.status.defaultLevel,
	);
	const log = $derived(turnLog(input.turn));
	const parts = $derived(log.segment.activity);
	const hasHandBacks = $derived(log.handBacks.length > 0);
	const allRead = $derived(
		parts.some((part) => part.type === "assistant") &&
			parts.every(
				(part) => part.type !== "assistant" || part.surfacingRead === true,
			),
	);
	// An unanswered async question outlives its runner, so it keeps Q&A in view.
	const openHandBack = $derived(
		log.handBacks.some((tool) =>
			isOpenHandBack(tool, pendingQuestionFor(tool.id)),
		),
	);
	const collapsed = $derived(
		turnMinimised(input.sessionId, input.turn.id) ??
			(!((phase !== "settled" && hasHandBacks) || openHandBack) &&
				(!input.jev ||
					input.status.turnsOpen === "minimised" ||
					(input.status.turnsOpen === "auto" &&
						phase === "settled" &&
						!input.newestSettledTurn &&
						allRead &&
						!openAsk(parts, input.categorySet, input.latestTurn)))),
	);
	const choice = $derived.by(() => {
		const stored = choices.get(key);
		switch (phase) {
			case "live":
			case "waiting":
				return stored?.live?.segment === input.turn.segments.length - 1 &&
					(phase === "waiting" || stored.live.phase === "live")
					? stored.live.choice
					: phase === "waiting"
						? "qa"
						: "log";
			case "settled":
				return stored?.settled ?? (openHandBack ? "qa" : null);
			default:
				return assertNever(phase);
		}
	});
	const view = $derived.by((): TurnPanel => {
		if (collapsed && !reveal) return { kind: "collapsed" };
		const selected = revealStop ?? choice;
		// Jev off offers only Full log, so the saved level falls back to it.
		const level = stops.find((stop) => stop === saved) ?? stops[0];
		switch (selected) {
			case "qa":
				if (hasHandBacks) return { kind: "open", view: { kind: "qa" } };
				return {
					kind: "open",
					view: { kind: "show", stop: level },
				};
			case "usage":
				return { kind: "open", view: { kind: "usage" } };
			case null:
			case "level":
			case "log":
				return {
					kind: "open",
					view: {
						kind: "show",
						stop: selected === "log" ? "log" : level,
					},
				};
			default:
				return assertNever(selected);
		}
	});
	function pick(choice: TurnChoice) {
		const previous = choices.get(key) ?? { settled: null, live: null };
		switch (phase) {
			case "live":
			case "waiting":
				choices.set(key, {
					...previous,
					live: { choice, segment: input.turn.segments.length - 1, phase },
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
		setTurnMinimised(input.sessionId, input.turn.id, false);
	}
	$effect(() => {
		const sessionId = input.sessionId;
		if (sessionId && input.jev) untrack(() => touchSurfaceSession(sessionId));
	});
	return {
		get phase() {
			return phase;
		},
		get hasHandBacks() {
			return hasHandBacks;
		},
		get stops() {
			return stops;
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
		get pending() {
			return reveal;
		},
		get target() {
			return reveal?.target ?? null;
		},
		ack(seq) {
			if (!reveal || reveal.seq !== seq) return;
			open();
			pick(revealStop === "log" ? "log" : "level");
			pending.delete(input.viewId);
			receipts.get(seq)?.("landed");
			receipts.delete(seq);
		},
		open,
		collapse() {
			setTurnMinimised(input.sessionId, input.turn.id, true);
		},
		show(stop) {
			if (!stops.some((available) => available === stop)) return;
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
		qa() {
			if (!hasHandBacks) return;
			pick("qa");
			open();
		},
		hold() {
			// Answering changes what Auto sees, so the Turn keeps the view it was answered in.
			setTurnMinimised(input.sessionId, input.turn.id, false);
			pick("qa");
		},
		async makeDefault() {
			if (input.sessionId) await makeSurfaceDefault(input.sessionId, saved);
		},
		resetLevel() {
			if (input.sessionId) setSessionSurfaceLevel(input.sessionId, null);
		},
	};
}
