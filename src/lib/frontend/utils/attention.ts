import type { Attachment } from "svelte/attachments";
import { on } from "svelte/events";
import { getBrowserClientId } from "../stores/client-identity.js";
import { getCurrentSlug } from "../stores/router.svelte.js";
import { findSession } from "../stores/session.svelte.js";
import { showToast } from "../stores/ui.svelte.js";
import { markSessionSeenRpc } from "../transport/ws-rpc-client.js";
import type { SessionInfo } from "../types.js";

// Browser half of read state (ADR-0004, Scope; conduit-test-hk9m.4). Only
// interaction clears a dot: a sidebar pick, or a touch on the session view
// while the page is visible and the newest turn end is on screen. Opening,
// reloading, reconnecting and window focus never report.

/** How the user touched a session. */
export type TouchSource =
	| "click"
	| "scroll"
	| "key"
	| "input-focus"
	| "pointer-dwell"
	| "sidebar-pick";

interface AttentionState {
	readonly unread: boolean;
	readonly lastTurnEndVersion: number | undefined;
	/** The turn end this tab already reported: the rest of a burst is quiet. */
	readonly reported: number | undefined;
	readonly pageVisible: boolean;
	/** The newest turn end is inside the transcript's viewport and the window's. */
	readonly turnEndInView: boolean;
}

/** Whether a touch reports the session seen, and up to which turn end. */
function decide(
	state: AttentionState,
	source: TouchSource,
): { readonly upTo: number } | null {
	const upTo = state.lastTurnEndVersion;
	if (!state.unread) return null;
	// A session marked unread before its first turn end has no version; 0
	// still clears it, since seen is capped at its virtual turn end of -1.
	if (source === "sidebar-pick") return { upTo: upTo ?? 0 };
	if (
		upTo === undefined ||
		state.reported === upTo ||
		!state.pageVisible ||
		!state.turnEndInView
	)
		return null;
	return { upTo };
}

const reported = new Map<string, number>();

export function touch(
	session: Pick<
		SessionInfo,
		"id" | "unread" | "lastTurnEndVersion" | "projectSlug"
	>,
	source: TouchSource,
	turnEndInView = false,
): void {
	const report = decide(
		{
			unread: session.unread === true,
			lastTurnEndVersion: session.lastTurnEndVersion,
			reported: reported.get(session.id),
			pageVisible: document.visibilityState === "visible",
			turnEndInView,
		},
		source,
	);
	const projectSlug = session.projectSlug ?? getCurrentSlug();
	if (!report || !projectSlug) return;
	reported.set(session.id, report.upTo);
	markSessionSeenRpc({
		projectSlug,
		sessionId: session.id,
		upTo: report.upTo,
		originId: getBrowserClientId(),
	}).catch(() => {
		if (reported.get(session.id) === report.upTo) reported.delete(session.id);
		showToast("Couldn't mark read", { variant: "error" });
	});
}

const DWELL_MS = 300;
/** How long after a gesture the scrolling it set off still counts as the user's. */
const SCROLL_FOLLOW_MS = 1_000;

/**
 * Whether the newest turn end (the marker MessageList renders after it) is
 * inside both the transcript's scrollport and the window. A scrolled-up
 * transcript or a view moved off screen has it outside, so nothing is marked.
 */
function turnEndInView(view: HTMLElement): boolean {
	const marker = view.querySelector("[data-turn-end]");
	const transcript = marker?.closest("#messages");
	if (!marker || !transcript) return false;
	const { top, left } = marker.getBoundingClientRect();
	const box = transcript.getBoundingClientRect();
	return (
		top >= Math.max(box.top, 0) &&
		top <= Math.min(box.bottom, innerHeight) &&
		left >= 0 &&
		left <= innerWidth
	);
}

/**
 * On the session view (transcript and composer). Clicks, wheel or touch
 * scrolls and keys count at once, as does scrolling they set off, since an End
 * key or a flick reaches the turn end only after the gesture. Focus counts
 * when it moves in from another element: focus the browser restores when the
 * window regains it has no related target. A pointer counts once it has
 * rested over the transcript; moves that keep its position (the browser's
 * synthetic moves as content scrolls under it) do not restart the rest.
 */
export function trackSeen(sessionId: string | null): Attachment<HTMLElement> {
	return (view) => {
		if (!sessionId) return;
		const report = (source: TouchSource) => {
			const session = findSession(sessionId);
			if (session) touch(session, source, turnEndInView(view));
		};
		let gestureAt = Number.NEGATIVE_INFINITY;
		const gesture = (source: TouchSource) => (event: Event) => {
			if (!event.isTrusted) return;
			gestureAt = performance.now();
			report(source);
		};
		let dwell: ReturnType<typeof setTimeout> | undefined;
		let pointer: { readonly x: number; readonly y: number } | undefined;
		const stopDwell = () => {
			clearTimeout(dwell);
			dwell = undefined;
			pointer = undefined;
		};
		const off = [
			on(view, "pointerdown", gesture("click")),
			on(view, "wheel", gesture("scroll"), { passive: true }),
			on(view, "touchmove", gesture("scroll"), { passive: true }),
			on(view, "keydown", gesture("key")),
			on(
				view,
				"scroll",
				() => {
					if (performance.now() - gestureAt <= SCROLL_FOLLOW_MS)
						report("scroll");
				},
				{ capture: true, passive: true },
			),
			on(view, "focusin", (event) => {
				if (event.isTrusted && event.relatedTarget) report("input-focus");
			}),
			on(view, "pointermove", (event) => {
				if (!event.isTrusted || event.pointerType === "touch") return;
				if (pointer?.x === event.clientX && pointer.y === event.clientY) return;
				stopDwell();
				pointer = { x: event.clientX, y: event.clientY };
				if (
					event.target instanceof Element &&
					event.target.closest("#messages")
				)
					dwell = setTimeout(() => report("pointer-dwell"), DWELL_MS);
			}),
			on(view, "pointerleave", stopDwell),
		];
		return () => {
			stopDwell();
			for (const remove of off) remove();
		};
	};
}
