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
	onContainerResize(): void;
	onPrepend(prevScrollHeight: number, prevScrollTop: number): void;
}

const SETTLE_MAX_FRAMES = 60;
const SETTLE_STABLE_THRESHOLD = 2;
const DETACH_THRESHOLD = 50; // px from bottom to trigger detach via scroll position
const REFOLLOW_THRESHOLD = 5; // px from bottom to re-follow (tight to prevent accidental re-follow from casual scrolling)

export function createScrollController(
	getLifecycle: () => LoadLifecycle,
	onUserScroll?: () => void,
): ScrollController {
	let container: HTMLElement | null = null;
	let userDetached = $state(false);
	let settleRafId: number | null = null;
	let settleFrameCount = 0;
	let programmaticScrollCount = 0; // counter — prevents false detach from our own scrolls
	let resetTimerScheduled = false; // guards against scheduling multiple reset timers

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
		// Safety reset: setTimeout(0) fires in the NEXT task, which is after
		// the current rendering cycle (scroll events + rAF). This means:
		//   scrollToBottom() → scroll events fire → rAF fires → setTimeout fires
		// By the time the timer fires, all scroll events from this
		// scrollToBottom() call have been processed and have consumed their
		// counter slots. The reset cleans up any unconsumed slots (e.g. when
		// scrollToBottom() didn't change position and no event fired).
		// Unlike rAF, setTimeout(0) won't fire BETWEEN scroll events, so
		// it can't zero the counter while events are still pending.
		if (!resetTimerScheduled) {
			resetTimerScheduled = true;
			setTimeout(() => {
				programmaticScrollCount = 0;
				resetTimerScheduled = false;
			}, 0);
		}
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

		// Only a scroll that left the bottom counts as user intent. The counter
		// guard above is necessary but not sufficient: the settle loop re-pins
		// every frame, and a coalesced scroll event from one of those writes can
		// be delivered after the counter's setTimeout(0) safety reset has zeroed
		// its slot, at which point it is indistinguishable from a real scroll.
		// Every such stray lands at the bottom, because pinning is what caused
		// it — so the distance is what tells them apart. This was measured, not
		// theorised: without it the session bar arrived collapsed on load, before
		// the user had touched anything.
		//
		// Nothing is lost by declining to report a scroll that ends at the
		// bottom: returning to the bottom is already an atBottom rising edge, and
		// that edge is what the bar listens to.
		if (distFromBottom >= REFOLLOW_THRESHOLD) {
			// And not while the transcript is still hydrating, where the controller
			// is force-pinning the bottom and any position off it is transient.
			const s = getState();
			if (s === "following" || s === "detached") onUserScroll?.();
		}

		// Re-follow when scrolled to the very bottom (within 5px).
		// All programmatic scrolls early-returned above, so this is
		// always a user-initiated scroll.
		if (distFromBottom < REFOLLOW_THRESHOLD && userDetached) {
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

		// Anti-oscillation: collapsing the bar changes the container height and can
		// fire a scroll event. Re-pin through scrollToBottom() so it consumes a
		// programmaticScrollCount slot and is never counted as user intent.
		// This is the single most likely thing a future reader deletes as redundant.
		onContainerResize(): void {
			if (getState() === "following") scrollToBottom();
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
