import {
	type CategorySet,
	type SurfacingLevel,
	type SurfacingMark,
	surfacingLevel,
} from "../../contracts/category-set.js";
import { rpc } from "../transport/ws-rpc-client.js";
import type { AssistantMessage } from "../types.js";
import { SURFACE_LABELS, type SurfacePin } from "../utils/surface-turn.js";

type Direction = "raise" | "lower" | "retype";
type LedgerEntry = { sessionId: string; partId: string; mark: SurfacingMark };
type Pending = {
	pin: SurfacePin;
	direction: Direction;
	place: string;
	mark: SurfacingMark | null;
};
const levels: readonly SurfacingLevel[] = ["hidden", "all", "balanced", "key"];
export const MARK_GLYPHS = { raise: "▲", lower: "▼", retype: "⇄" };
export const feedbackLedger = $state<{ entries: readonly LedgerEntry[] }>({
	entries: [],
});

export async function loadSurfacingFeedback(): Promise<void> {
	try {
		feedbackLedger.entries = await rpc("GetSurfacingFeedback", {});
	} catch {
		/* A ledger outage must not disable the transcript or local corrections. */
	}
}

/** One turn's correction editor. Persisted part annotations remain the source of truth. */
export class SurfacingFeedback {
	pending = $state<Pending | null>(null);
	reason = $state("");
	saving = $state(false);
	error = $state("");
	toast = $state<{
		text: string;
		pin: SurfacePin;
		previous: SurfacingMark | null;
		place: string;
	} | null>(null);
	private edits = $state.raw<
		Record<string, { base: AssistantMessage; mark: SurfacingMark | null }>
	>({});
	private timer: ReturnType<typeof setTimeout> | undefined;
	constructor(
		private sessionId: () => string | undefined,
		private categorySet: () => CategorySet,
		private focus: (place: string) => void,
		private hold: (pin: SurfacePin) => void,
		private currentPart: (uuid: string) => AssistantMessage | undefined,
	) {}

	annotate(part: AssistantMessage): AssistantMessage {
		const edit = this.edits[part.uuid];
		return edit && part === edit.base
			? { ...part, surfacingMark: edit.mark }
			: part;
	}
	begin(pin: SurfacePin, direction: Direction, place = "card"): void {
		if (this.saving || !this.sessionId() || !pin.part.partId) return;
		const previous = pin.part.surfacingMark;
		if (previous?.direction === direction) {
			if (place === "card") this.hold(pin);
			void this.save(pin, null, place);
			return;
		}
		const index = levels.indexOf(pin.level);
		if (
			(direction === "raise" && index === 3) ||
			(direction === "lower" && index === 0)
		)
			return;
		if (place === "card") this.hold(pin);
		const level = levels[index + (direction === "raise" ? 1 : -1)] ?? "hidden";
		this.pending = {
			pin,
			direction,
			place,
			mark:
				direction === "retype"
					? null
					: {
							level,
							direction,
							...(previous?.category ? { category: previous.category } : {}),
						},
		};
		this.reason = "";
		this.error = "";
	}
	retype(category: string): void {
		const pending = this.pending;
		const selected = this.categorySet().categories.find(
			(item) => item.id === category && !item.retired,
		);
		if (!pending || !selected) return;
		const level = surfacingLevel(
			{ probabilities: { [category]: 1 } },
			{ categories: [selected] },
		).level;
		this.pending = {
			...pending,
			mark: { level, category, direction: "retype" },
		};
	}
	reasons(): string[] {
		const counts = new Map<string, number>();
		for (const { mark } of feedbackLedger.entries) {
			if (mark.direction !== this.pending?.direction || !mark.reason?.trim())
				continue;
			counts.set(mark.reason, (counts.get(mark.reason) ?? 0) + 1);
		}
		return [...counts]
			.sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b))
			.slice(0, 3)
			.map(([reason]) => reason);
	}
	async submit(reason = this.reason): Promise<void> {
		const pending = this.pending;
		if (!pending?.mark) return;
		await this.save(
			pending.pin,
			{ ...pending.mark, ...(reason.trim() ? { reason: reason.trim() } : {}) },
			pending.place,
		);
	}
	cancel(): void {
		if (this.saving) return;
		const place = this.pending?.place ?? "card";
		this.pending = null;
		this.error = "";
		this.focus(place);
	}
	command(key: string, pin: SurfacePin | null): boolean {
		if (!pin || !["+", "-", "−"].includes(key)) return false;
		this.begin(pin, key === "+" ? "raise" : "lower");
		return true;
	}
	async undo(): Promise<void> {
		const toast = this.toast;
		if (!toast) return;
		await this.save(toast.pin, toast.previous, toast.place, true);
	}
	private async save(
		pin: SurfacePin,
		mark: SurfacingMark | null,
		place: string,
		undo = false,
	): Promise<void> {
		const sessionId = this.sessionId(),
			partId = pin.part.partId;
		if (!sessionId || !partId || this.saving) return;
		this.saving = true;
		this.error = "";
		const current = this.currentPart(pin.part.uuid) ?? pin.part;
		const previous = this.annotate(current).surfacingMark ?? null;
		try {
			await rpc("SetSurfacingMark", { sessionId, partId, mark });
			// The override bridges the RPC and its part-row delta. A newer part wins.
			this.edits = { ...this.edits, [pin.part.uuid]: { base: current, mark } };
			feedbackLedger.entries = feedbackLedger.entries.filter(
				(entry) => entry.sessionId !== sessionId || entry.partId !== partId,
			);
			if (mark)
				feedbackLedger.entries = [
					...feedbackLedger.entries,
					{ sessionId, partId, mark },
				];
			this.pending = null;
			clearTimeout(this.timer);
			if (undo) this.toast = null;
			else {
				const verb =
					mark?.direction === "retype"
						? "Retyped"
						: mark?.direction === "lower"
							? "Lowered"
							: "Raised";
				const text = mark
					? `${MARK_GLYPHS[mark.direction ?? "raise"]} ${verb} #${pin.number ?? "?"} to ${SURFACE_LABELS[mark.level]}`
					: `Cleared mark #${pin.number ?? "?"}`;
				this.toast = { text, pin, previous, place };
				this.timer = setTimeout(() => {
					this.toast = null;
				}, 6000);
			}
			this.focus(place);
		} catch {
			this.error = "Couldn't save the correction. Try again.";
		} finally {
			this.saving = false;
		}
	}
	dispose(): void {
		clearTimeout(this.timer);
	}
}
