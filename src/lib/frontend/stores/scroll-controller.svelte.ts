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
const DETACH_THRESHOLD = 50; // px from bottom to trigger detach via scroll position
const REFOLLOW_THRESHOLD = 5; // px from bottom to re-follow (tight to prevent accidental re-follow from casual scrolling)

export function createScrollController(
	getLifecycle: () => LoadLifecycle,
): ScrollController {
	let container: HTMLElement | null = null;
	let userDetached = $state(false);
	let settleRafId: number | null = null;
	let settleFrameCount = 0;
	let programmaticScrollCount = 0; // counter (not boolean) — prevents false detach when multiple scrollToBottom() calls queue up in the same frame

	function getState(): ScrollState {
		const lc = getLifecycle();
		if (lc === "empty" || lc === "loading") return "loading";
		if (lc === "committed") return "settling";
		if (userDetached) return "detached";
		return "following";
	}

	function scrollToBottom(): void {
		if (!container) return;
		programmaticScrollCount++;
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

		// Track whether this was a programmatic scroll (from scrollToBottom).
		const isProgrammatic = programmaticScrollCount > 0;
		if (isProgrammatic) {
			programmaticScrollCount--;
		}

		// Skip detach/re-follow logic if content doesn't overflow the
		// container. Without this guard, edge cases (e.g. browser firing a
		// scroll event on a non-overflowing container) could falsely detach.
		if (container.scrollHeight <= container.clientHeight) return;

		const distFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;

		// Re-follow only when scrolled to the very bottom (within 5px) AND
		// the scroll was user-initiated. Skip for programmatic scrolls so
		// that scrollToBottom() doesn't accidentally clear userDetached.
		if (
			!isProgrammatic &&
			distFromBottom < REFOLLOW_THRESHOLD &&
			userDetached
		) {
			userDetached = false;
		}
		// Detach when scrolled away from bottom — only for user-initiated
		// scrolls. Programmatic scrolls can land with a stale position when
		// content grows between the scrollToBottom() call and the scroll
		// event, causing false detach. If the user scrolls up while a
		// programmatic scroll is in-flight, the user's own scroll generates
		// a separate non-programmatic event that will trigger detach.
		if (
			!isProgrammatic &&
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
			// Scroll immediately so the first paint of the new session is at the
			// bottom, not at whatever scroll position the previous session had.
			scrollToBottom();
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
				// Scroll synchronously first to avoid a one-frame paint at scrollTop=0,
				// then start the rAF settle loop for any subsequent height changes
				// (deferred markdown rendering, lazy images, etc.).
				scrollToBottom();
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
