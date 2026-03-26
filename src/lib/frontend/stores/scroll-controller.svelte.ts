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
const SCROLL_THRESHOLD = 100;

export function createScrollController(
	getLifecycle: () => LoadLifecycle,
): ScrollController {
	let container: HTMLElement | null = null;
	let userDetached = $state(false);
	let settleRafId: number | null = null;
	let settleFrameCount = 0;

	function getState(): ScrollState {
		const lc = getLifecycle();
		if (lc === "empty" || lc === "loading") return "loading";
		if (lc === "committed") return "settling";
		if (userDetached) return "detached";
		return "following";
	}

	function scrollToBottom(): void {
		if (!container) return;
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

	let lastTouchY = 0;

	function onTouchStart(e: TouchEvent): void {
		if (e.touches.length > 0 && e.touches[0]) {
			lastTouchY = e.touches[0].clientY;
		}
	}

	function onTouchMove(e: TouchEvent): void {
		if (e.touches.length > 0 && e.touches[0] && getState() === "following") {
			const currentY = e.touches[0].clientY;
			if (currentY > lastTouchY + 5) {
				userDetached = true;
			}
			lastTouchY = currentY;
		}
	}

	function onWheel(e: WheelEvent): void {
		if (e.deltaY < 0 && getState() === "following") {
			userDetached = true;
		}
	}

	function onScroll(): void {
		if (!container) return;
		const distFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		// Re-follow when scrolled near bottom
		if (distFromBottom < SCROLL_THRESHOLD && userDetached) {
			userDetached = false;
		}
		// Detach when scrolled away from bottom (catches keyboard scroll,
		// programmatic scroll, page search, etc. — not just wheel/touch).
		if (
			distFromBottom > SCROLL_THRESHOLD &&
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
			el.addEventListener("wheel", onWheel, { passive: true });
			el.addEventListener("touchstart", onTouchStart, { passive: true });
			el.addEventListener("touchmove", onTouchMove, { passive: true });
			el.addEventListener("scroll", onScroll, { passive: true });
		},

		detach(): void {
			stopSettle();
			if (container) {
				container.removeEventListener("wheel", onWheel);
				container.removeEventListener("touchstart", onTouchStart);
				container.removeEventListener("touchmove", onTouchMove);
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
				requestAnimationFrame(() => scrollToBottom());
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
