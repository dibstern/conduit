// ─── Scroll Controller ───────────────────────────────────────────────────────
// State machine for chat scroll behavior. Derives scroll state from the chat
// store's LoadLifecycle signal and user input events.

import type { LoadLifecycle } from "./chat.svelte.js";

export type ScrollState = "loading" | "settling" | "following" | "detached";

export interface ScrollController {
	readonly state: ScrollState;
	readonly isDetached: boolean;
	readonly isLoading: boolean;
	attach(container: HTMLElement): void;
	detach(): void;
	resetForSession(): void;
	requestFollow(): void;
	onNewContent(): void;
	onPrepend(prevScrollHeight: number, prevScrollTop: number): void;
}

const SETTLE_MAX_FRAMES = 60;
const SETTLE_STABLE_THRESHOLD = 2;
const DETACH_THRESHOLD = 100; // px from bottom to trigger detach via scroll position
const REFOLLOW_THRESHOLD = 5; // px from bottom to re-follow (must be at the very bottom)

export function createScrollController(
	getLifecycle: () => LoadLifecycle,
): ScrollController {
	let container: HTMLElement | null = null;
	let userDetached = $state(false);
	let settleRafId: number | null = null;
	let settleFrameCount = 0;
	let programmaticScrollPending = false; // guards against false detach from our own scrolls

	function getState(): ScrollState {
		const lc = getLifecycle();
		if (lc === "empty" || lc === "loading") return "loading";
		if (lc === "committed") return "settling";
		if (userDetached) return "detached";
		return "following";
	}

	function scrollToBottom(): void {
		if (!container) return;
		programmaticScrollPending = true;
		container.scrollTop = container.scrollHeight;
	}

	function startSettle(): void {
		if (settleRafId !== null) return;
		settleFrameCount = 0;
		let lastHeight = 0;
		let stableCount = 0;

		function tick() {
			if (!container || settleFrameCount++ > SETTLE_MAX_FRAMES) {
				stopSettle();
				return;
			}
			const lc = getLifecycle();
			if (lc !== "committed") {
				stopSettle();
				return;
			}
			scrollToBottom();
			const h = container.scrollHeight;
			if (h === lastHeight) {
				stableCount++;
				if (stableCount >= SETTLE_STABLE_THRESHOLD) {
					stopSettle();
					return;
				}
			} else {
				stableCount = 0;
			}
			lastHeight = h;
			settleRafId = requestAnimationFrame(tick);
		}

		settleRafId = requestAnimationFrame(tick);
	}

	function stopSettle(): void {
		if (settleRafId !== null) {
			cancelAnimationFrame(settleRafId);
			settleRafId = null;
		}
	}

	function onScroll(): void {
		if (!container) return;

		// If we triggered this scroll via scrollToBottom(), skip the detach
		// check. Without this, a race occurs: scrollToBottom sets scrollTop,
		// then a new delta arrives and increases scrollHeight before the
		// scroll event fires, making distFromBottom > DETACH_THRESHOLD and
		// falsely detaching.
		if (programmaticScrollPending) {
			programmaticScrollPending = false;
			return;
		}

		// Skip detach/re-follow logic if content doesn't overflow the
		// container. Without this guard, edge cases (e.g. browser firing a
		// scroll event on a non-overflowing container) could falsely detach.
		if (container.scrollHeight <= container.clientHeight) return;

		const distFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		// Re-follow only when scrolled to the very bottom.
		// Uses a tight threshold (5px) to avoid undoing detach for small
		// scrolls. The user must scroll all the way back down.
		if (distFromBottom < REFOLLOW_THRESHOLD && userDetached) {
			userDetached = false;
		}
		// Detach when scrolled away from bottom (catches all user-initiated
		// scroll: wheel, touch, keyboard, page search, etc.).
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

		attach(el: HTMLElement): void {
			container = el;
			el.addEventListener("scroll", onScroll, { passive: true });
		},

		detach(): void {
			stopSettle();
			if (container) {
				container.removeEventListener("scroll", onScroll);
				container = null;
			}
		},

		resetForSession(): void {
			userDetached = false;
			stopSettle();
		},

		requestFollow(): void {
			userDetached = false;
			scrollToBottom();
		},

		onNewContent(): void {
			const s = getState();
			if (s === "following") {
				// Scroll synchronously — not via rAF. In Svelte 5, $effect runs
				// after the DOM is committed but before the browser paints. Scrolling
				// here means the browser paints with the correct scroll position.
				// Using rAF would delay the scroll by one frame, causing visible
				// jitter during streaming (snap-down-then-back-up on each delta).
				scrollToBottom();
			} else if (s === "settling") {
				startSettle();
			}
		},

		onPrepend(prevScrollHeight: number, prevScrollTop: number): void {
			if (!container) return;
			requestAnimationFrame(() => {
				if (!container) return;
				const newScrollHeight = container.scrollHeight;
				container.scrollTop =
					prevScrollTop + (newScrollHeight - prevScrollHeight);
			});
		},
	};
}
