import type { Action } from "svelte/action";

type DragToDismissOptions = {
	ondismiss: () => void;
	/** 0 at rest, 1 fully dragged off; `settling` is true while the sheet animates on its own. */
	onprogress?: (progress: number, settling: boolean) => void;
};

const DISMISS_FRACTION = 0.25;
const FLICK_PX_PER_MS = 0.5;
const SETTLE_MS = 220;

/**
 * Lets a bottom sheet be pulled down and dismissed by a finger. A downward pull
 * becomes a drag only while the sheet's content is scrolled to the top, so a
 * long sheet still scrolls normally. Touch events rather than pointer events:
 * the sheet is a scroll container, and only a non-passive touchmove can stop
 * the browser from claiming the gesture as an overscroll bounce.
 */
export const dragToDismiss: Action<HTMLElement, DragToDismissOptions> = (
	node,
	initial,
) => {
	let options = initial;
	let tracking = false;
	let dragging = false;
	let startY = 0;
	let lastY = 0;
	let lastTime = 0;
	let velocity = 0;
	let dismissTimer: ReturnType<typeof setTimeout> | undefined;

	const settleMs = () =>
		matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : SETTLE_MS;

	function place(offset: number, settling: boolean) {
		node.style.transition = settling
			? `transform ${settleMs()}ms cubic-bezier(0.32, 0.72, 0, 1)`
			: "none";
		node.style.transform = offset > 0 ? `translateY(${offset}px)` : "";
		options.onprogress?.(Math.min(offset / node.offsetHeight, 1), settling);
	}

	function onStart(event: TouchEvent) {
		const touch = event.touches[0];
		tracking =
			event.touches.length === 1 &&
			touch !== undefined &&
			dismissTimer === undefined;
		dragging = false;
		if (!touch) return;
		startY = lastY = touch.clientY;
		lastTime = event.timeStamp;
		velocity = 0;
	}

	function onMove(event: TouchEvent) {
		const touch = event.touches[0];
		if (!tracking || !touch) return;
		const offset = touch.clientY - startY;
		if (!dragging) {
			if (offset === 0) return;
			// The first movement decides: up, or down inside scrolled content, is a scroll.
			if (offset < 0 || node.scrollTop > 0) {
				tracking = false;
				return;
			}
			dragging = true;
		}
		event.preventDefault();
		const elapsed = event.timeStamp - lastTime;
		if (elapsed > 0) velocity = (touch.clientY - lastY) / elapsed;
		lastY = touch.clientY;
		lastTime = event.timeStamp;
		place(Math.max(offset, 0), false);
	}

	function onEnd() {
		const wasDragging = dragging;
		tracking = dragging = false;
		if (!wasDragging) return;
		const offset = lastY - startY;
		if (
			offset > node.offsetHeight * DISMISS_FRACTION ||
			velocity > FLICK_PX_PER_MS
		) {
			place(node.offsetHeight, true);
			dismissTimer = setTimeout(() => options.ondismiss(), settleMs());
		} else {
			place(0, true);
		}
	}

	function onCancel() {
		if (dragging) place(0, true);
		tracking = dragging = false;
	}

	node.addEventListener("touchstart", onStart, { passive: true });
	node.addEventListener("touchmove", onMove, { passive: false });
	node.addEventListener("touchend", onEnd);
	node.addEventListener("touchcancel", onCancel);
	return {
		update(next) {
			options = next;
		},
		destroy() {
			clearTimeout(dismissTimer);
			node.removeEventListener("touchstart", onStart);
			node.removeEventListener("touchmove", onMove);
			node.removeEventListener("touchend", onEnd);
			node.removeEventListener("touchcancel", onCancel);
		},
	};
};
