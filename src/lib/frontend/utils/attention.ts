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
	/** The latest turn end was marked unread while this tab had it open. */
	readonly held: boolean;
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
		state.held ||
		state.reported === upTo ||
		!state.pageVisible ||
		!state.turnEndInView
	)
		return null;
	return { upTo };
}

const reported = new Map<string, number>();
/** Turn ends marked unread while open here, by session (see observeOpenSession). */
const held = new Map<string, number>();

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
			held: held.get(session.id) === session.lastTurnEndVersion,
			pageVisible: document.visibilityState === "visible",
			turnEndInView,
		},
		source,
	);
	const projectSlug = session.projectSlug ?? getCurrentSlug();
	if (!report || !projectSlug) return;
	reported.set(session.id, report.upTo);
	send(session.id, projectSlug, report.upTo);
}

/**
 * Reports a dropped connection kept from reaching the server, one per session.
 * Each is sent once when its project reattaches, and only if the row is still
 * unread (conduit-test-hk9m.6).
 */
const pending = new Map<
	string,
	{ readonly projectSlug: string; readonly upTo: number }
>();

function send(sessionId: string, projectSlug: string, upTo: number): void {
	pending.delete(sessionId);
	markSessionSeenRpc({
		projectSlug,
		sessionId,
		upTo,
		originId: getBrowserClientId(),
	}).then(
		(outcome) => {
			// `reported` stays set, so the rest of the burst stays quiet.
			if (outcome === "disconnected")
				pending.set(sessionId, { projectSlug, upTo });
		},
		() => {
			if (reported.get(sessionId) === upTo) reported.delete(sessionId);
			showToast("Couldn't mark read", { variant: "error" });
		},
	);
}

/** Call once the reattached project's fresh session list is applied. */
export function flushPendingSeen(projectSlug: string): void {
	for (const [sessionId, report] of pending) {
		if (report.projectSlug !== projectSlug) continue;
		pending.delete(sessionId);
		if (findSession(sessionId)?.unread === true)
			send(sessionId, projectSlug, report.upTo);
	}
}

type OpenSession = Pick<SessionInfo, "id" | "unread" | "lastTurnEndVersion">;
let open: OpenSession | undefined;

/**
 * Follows the session this tab has open (conduit-test-hk9m.5). A row that
 * turns unread while its turn end stays put was marked unread, here or in
 * another window, so touches on the view leave it until the user switches
 * away; a newer turn end is a new dot and counts as usual. Judged from the
 * row's own `unread`, never `attention`, which a root rolls up from its forks.
 * Switching away ends the departing session's hold and burst, so coming back
 * counts as usual.
 */
export function observeOpenSession(session: OpenSession | undefined): void {
	const upTo = session?.lastTurnEndVersion;
	if (open && open.id !== session?.id) {
		held.delete(open.id);
		reported.delete(open.id);
	} else if (
		session?.unread === true &&
		open?.unread !== true &&
		upTo !== undefined &&
		upTo === open?.lastTurnEndVersion
	)
		held.set(session.id, upTo);
	open = session && {
		id: session.id,
		unread: session.unread,
		lastTurnEndVersion: upTo,
	};
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
