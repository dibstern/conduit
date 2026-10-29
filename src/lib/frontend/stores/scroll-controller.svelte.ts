// State machine for chat scroll behavior. Derives scroll state from the chat
// store's LoadLifecycle signal and user input events.

import { untrack } from "svelte";
import type { LoadLifecycle } from "./chat.svelte.js";

export type ScrollState = "loading" | "following" | "detached";

export interface ScrollController {
	readonly state: ScrollState;
	readonly isDetached: boolean;
	readonly isLoading: boolean;
	/** The last known position was the bottom. Content growth since does not
	 *  unset it, so it answers "was the reader at the bottom before this?". */
	readonly isPinned: boolean;
	readonly activeMessageId: string | null;
	place(target: { messageId: string } | "latest"): boolean;
	attach(container: HTMLElement): void;
	detach(): void;
	resetForSession(): void;
	requestFollow(): void;
	/** Suspend following before a reveal; sample its final position next frame. */
	requestJump(): void;
	onNewContent(): void;
	onContainerResize(): void;
	onPrepend(prevScrollHeight: number, prevScrollTop: number): void;
}

const DETACH_THRESHOLD = 50; // px from bottom to trigger detach via scroll position
const REFOLLOW_THRESHOLD = 5; // px from bottom to re-follow (tight to prevent accidental re-follow from casual scrolling)

export function createScrollController(
	getLifecycle: () => LoadLifecycle,
	getNavigation: () => {
		historical: boolean;
		busy: boolean;
		topClearance: number;
		identity: number;
	} = () => ({ historical: false, busy: false, topClearance: 0, identity: 0 }),
): ScrollController {
	let container: HTMLElement | null = null;
	let userDetached = $state(false);
	let pinned = true;
	let programmaticScrollCount = 0; // counter — prevents false detach from our own scrolls
	let resetTimerScheduled = false; // guards against scheduling multiple reset frames
	let jumpFrame: number | null = null;
	let activeMessageId = $state<string | null>(null);
	let selectedTop: number | null = null;
	let mutation: MutationObserver | undefined;
	let resize: ResizeObserver | undefined;
	const observed = new Set<Element>();
	let measureFrame: { handle?: number } | null = null;
	let attachment = 0;

	function measure() {
		if (!container) return;
		for (const child of observed) {
			if (child.parentElement !== container) {
				resize?.unobserve(child);
				observed.delete(child);
			}
		}
		for (const child of container.children) {
			if (!observed.has(child)) {
				resize?.observe(child);
				observed.add(child);
			}
		}
		if (getNavigation().busy) return;
		const rows = Array.from(
			container.querySelectorAll<HTMLElement>(".msg-user[data-message-id]"),
		).filter((row) => row.getClientRects().length > 0);
		if (
			selectedTop !== null &&
			Math.abs(container.scrollTop - selectedTop) < 1 &&
			rows.some((row) => row.dataset["messageId"] === activeMessageId)
		)
			return;
		selectedTop = null;
		const threshold =
			container.getBoundingClientRect().top +
			container.clientTop +
			getNavigation().topClearance +
			24;
		const atBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight <
			REFOLLOW_THRESHOLD;
		let row = rows[0];
		for (const candidate of rows) {
			if (!atBottom && candidate.getBoundingClientRect().top > threshold) break;
			row = candidate;
		}
		activeMessageId = row?.dataset["messageId"] ?? null;
	}

	function scheduleMeasure() {
		if (measureFrame !== null) return;
		const frame: { handle?: number } = {};
		measureFrame = frame;
		frame.handle = requestAnimationFrame(() => {
			if (measureFrame !== frame) return;
			measureFrame = null;
			untrack(measure);
		});
	}

	function onContentChange() {
		untrack(() => {
			// Late layout growth is not a scroll gesture. Preserve follow before
			// its queued scroll event can interpret the larger bottom gap as one.
			if (getState() === "following") scrollToBottom();
			scheduleMeasure();
		});
	}

	function cancelJump(): void {
		if (jumpFrame !== null) cancelAnimationFrame(jumpFrame);
		jumpFrame = null;
	}

	function getState(): ScrollState {
		const lc = getLifecycle();
		if (lc === "empty" || lc === "loading") return "loading";
		if (userDetached || getNavigation().historical || getNavigation().busy)
			return "detached";
		return "following";
	}

	function scrollToBottom(): void {
		if (!container || getNavigation().historical || getNavigation().busy)
			return;
		programmaticScrollCount++;
		pinned = true;
		container.scrollTop = container.scrollHeight;
		// Clear unconsumed slots (a scroll that moved nothing fires no event) on
		// the next frame. A frame dispatches scroll events before it runs rAF
		// callbacks, so this always lands after our own event. setTimeout(0) does
		// not: it can run before the frame, and then rows that render in between
		// make our own scroll read as the reader leaving the bottom.
		if (!resetTimerScheduled) {
			resetTimerScheduled = true;
			const epoch = attachment;
			requestAnimationFrame(() => {
				if (epoch !== attachment) return;
				programmaticScrollCount = 0;
				resetTimerScheduled = false;
			});
		}
	}

	function onScroll(): void {
		scheduleMeasure();
		if (!container || jumpFrame !== null) return;

		// If we triggered this scroll via scrollToBottom(), skip the detach
		// check. Uses a counter so that multiple scrollToBottom() calls in
		// the same frame each consume one slot instead of the second scroll
		// event bypassing the guard entirely.
		if (programmaticScrollCount > 0) {
			programmaticScrollCount--;
			return;
		}

		// Skip detach/re-follow logic if content doesn't overflow the
		// container. Without this guard, edge cases (e.g. browser firing a
		// scroll event on a non-overflowing container) could falsely detach.
		if (container.scrollHeight <= container.clientHeight) return;

		const distFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		pinned = distFromBottom < REFOLLOW_THRESHOLD;

		// Re-follow when scrolled to the very bottom (within 5px).
		// All programmatic scrolls early-returned above, so this is
		// always a user-initiated scroll.
		if (
			!getNavigation().historical &&
			!getNavigation().busy &&
			distFromBottom < REFOLLOW_THRESHOLD &&
			userDetached
		) {
			userDetached = false;
		}
		// Detach when scrolled away from bottom.
		if (
			distFromBottom > DETACH_THRESHOLD &&
			!userDetached &&
			getState() === "following"
		) {
			userDetached = true;
		}
	}

	return {
		get state(): ScrollState {
			return getState();
		},
		get isDetached(): boolean {
			return getState() === "detached";
		},
		get isLoading(): boolean {
			return getState() === "loading";
		},
		get isPinned(): boolean {
			return pinned;
		},

		get activeMessageId() {
			return activeMessageId;
		},
		place(target): boolean {
			if (!container) return false;
			cancelJump();
			if (target === "latest") {
				userDetached = false;
				container.scrollTop = container.scrollHeight;
				pinned = true;
				selectedTop = null;
				scheduleMeasure();
				return true;
			}
			const element = Array.from(
				container.querySelectorAll<HTMLElement>(".msg-user[data-message-id]"),
			).find(
				(row) =>
					row.dataset["messageId"] === target.messageId &&
					row.getClientRects().length > 0,
			);
			if (!element) return false;
			userDetached = true;
			const top =
				container.scrollTop +
				element.getBoundingClientRect().top -
				container.getBoundingClientRect().top -
				container.clientTop -
				getNavigation().topClearance -
				20;
			container.scrollTop = top;
			pinned = false;
			selectedTop =
				Math.abs(container.scrollTop - top) > 1 ? container.scrollTop : null;
			activeMessageId = target.messageId;
			return true;
		},

		attach(el: HTMLElement): void {
			attachment++;
			container = el;
			if (typeof MutationObserver !== "undefined") {
				mutation = new MutationObserver(onContentChange);
				mutation.observe(el, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["hidden", "data-message-id"],
				});
			}
			if (typeof ResizeObserver !== "undefined") {
				resize = new ResizeObserver(onContentChange);
				resize.observe(el);
			}
			scheduleMeasure();
			el.addEventListener("scroll", onScroll, { passive: true });
		},

		detach(): void {
			attachment++;
			mutation?.disconnect();
			resize?.disconnect();
			observed.clear();
			if (measureFrame?.handle !== undefined)
				cancelAnimationFrame(measureFrame.handle);
			measureFrame = null;
			resetTimerScheduled = false;
			cancelJump();
			if (container) {
				container.removeEventListener("scroll", onScroll);
				container = null;
			}
		},

		resetForSession(): void {
			activeMessageId = null;
			selectedTop = null;
			cancelJump();
			userDetached = false;
			// Scroll immediately so the first paint of the new session is at the
			// bottom, not at whatever scroll position the previous session had.
			scrollToBottom();
		},

		requestFollow(): void {
			cancelJump();
			userDetached = false;
			scrollToBottom();
		},

		requestJump(): void {
			if (!container) return;
			cancelJump();
			userDetached = true;
			pinned = false;
			// The reveal expands its DOM and scrolls after tick(). Ignore both
			// content and queued scroll events until that position has settled.
			const identity = getNavigation().identity;
			jumpFrame = requestAnimationFrame(() => {
				jumpFrame = null;
				if (!container || identity !== getNavigation().identity) return;
				programmaticScrollCount = 0;
				const gap =
					container.scrollHeight - container.scrollTop - container.clientHeight;
				pinned = gap < REFOLLOW_THRESHOLD;
				userDetached =
					!pinned || getNavigation().historical || getNavigation().busy;
			});
		},

		onNewContent(): void {
			scheduleMeasure();
			const state = getState();
			if (state === "following") {
				// Scroll synchronously — not via rAF. In Svelte 5, $effect runs
				// after the DOM is committed but before the browser paints. Scrolling
				// here means the browser paints with the correct scroll position.
				// Using rAF would delay the scroll by one frame, causing visible
				// jitter during streaming (snap-down-then-back-up on each delta).
				scrollToBottom();
			}
		},

		// Anti-oscillation: resizing can change the container height and can
		// fire a scroll event. Re-pin through scrollToBottom() so it consumes a
		// programmaticScrollCount slot and is never counted as user intent.
		// This is the single most likely thing a future reader deletes as redundant.
		onContainerResize(): void {
			if (getState() === "following") scrollToBottom();
		},

		onPrepend(prevScrollHeight: number, prevScrollTop: number): void {
			if (!container) return;
			const identity = getNavigation().identity;
			const epoch = attachment;
			requestAnimationFrame(() => {
				if (
					!container ||
					epoch !== attachment ||
					identity !== getNavigation().identity
				)
					return;
				const newScrollHeight = container.scrollHeight;
				container.scrollTop =
					prevScrollTop + (newScrollHeight - prevScrollHeight);
			});
		},
	};
}
