import type { Action } from "svelte/action";
import type { TransitionConfig } from "svelte/transition";

type DragToDismissOptions = {
	ondismiss: () => void;
	edge?: "bottom" | "top";
	/** Forms can lock dismissal while a save is in flight. */
	enabled?: boolean | undefined;
	/** 0 at rest, 1 fully dragged off; `settling` is true while the sheet animates on its own. */
	onprogress?: (progress: number, settling: boolean) => void;
	/** How far the sheet travels to be put away: off screen unless it collapses into something. */
	dismissOffset?: (() => number) | undefined;
};

/** A sheet released past this fraction of its height, or flicked faster, completes the move. */
export const DISMISS_FRACTION = 0.25;
export const FLICK_PX_PER_MS = 0.5;
const SETTLE_MS = 220;

export const settleMs = () =>
	matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : SETTLE_MS;

export const sheetScrimStyle = ({
	progress,
	settling,
}: {
	progress: number;
	settling: boolean;
}) =>
	`opacity: ${1 - progress}; transition: ${settling ? `opacity ${SETTLE_MS}ms linear` : "none"}`;

/**
 * Offsets a sheet `offset` px from its resting place, of `away` px to be put
 * away, gliding there when `settling`. Its dialog gets --sheet-raised, 1 at rest
 * and 0 put away, and --sheet-transition, so the scrim and anything else styled
 * from them move with the sheet. Returns how long the glide takes: nothing when
 * the sheet is already there.
 */
export function placeSheet(
	node: HTMLElement,
	offset: number,
	away: number,
	settling: boolean,
): number {
	const transform = offset !== 0 ? `translateY(${offset}px)` : "";
	const glideMs =
		settling && node.style.transform !== transform ? settleMs() : 0;
	const timing = `${glideMs}ms cubic-bezier(0.32, 0.72, 0, 1)`;
	const progress = away !== 0 ? Math.min(Math.max(offset / away, 0), 1) : 0;
	node.style.transition = `transform ${timing}`;
	node.style.transform = transform;
	const dialog = node.closest("dialog");
	dialog?.style.setProperty("--sheet-raised", String(1 - progress));
	dialog?.style.setProperty("--sheet-transition", timing);
	return glideMs;
}

/** Clip a drop-down below the live header, including after its size changes. */
export const sheetPosition: Action<HTMLElement, "bottom" | "top"> = (
	node,
	initial,
) => {
	let cleanup: (() => void) | undefined;
	function update(edge: "bottom" | "top") {
		cleanup?.();
		if (edge !== "top") return;
		const header = document.getElementById("session-bar");
		const measure = () =>
			node.style.setProperty(
				"--sheet-top",
				`${Math.max(0, header?.getBoundingClientRect().bottom ?? 0)}px`,
			);
		measure();
		const observer = new ResizeObserver(measure);
		if (header) observer.observe(header);
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		cleanup = () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
			node.style.removeProperty("--sheet-top");
		};
	}
	update(initial);
	return { update, destroy: () => cleanup?.() };
};

/** Hold the DOM through the same CSS glide used when a finger releases it. */
export function sheetGlide(
	node: HTMLElement,
	{ edge, onprogress }: Pick<DragToDismissOptions, "edge" | "onprogress">,
): (options?: { direction: "in" | "out" }) => TransitionConfig {
	return ({ direction } = { direction: "in" }) => {
		if (edge !== "top") return { duration: 0 };
		const away = -node.offsetHeight;
		if (direction === "out") {
			onprogress?.(1, true);
			return { duration: placeSheet(node, away, away, true) };
		}
		placeSheet(node, away, away, false);
		node.getBoundingClientRect();
		onprogress?.(1, false);
		requestAnimationFrame(() => {
			if (!node.isConnected) return;
			placeSheet(node, 0, away, true);
			onprogress?.(0, true);
		});
		return { duration: settleMs() };
	};
}

/**
 * Lets a sheet be pulled toward its edge and dismissed by a finger. A pull
 * becomes a drag only while its content is scrolled to that edge, so a long
 * sheet still scrolls normally. Touch events rather than pointer events:
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
	let scrollTargets: HTMLElement[] = [];
	const dialog = node.closest("dialog");

	const dismissOffset = () => options.dismissOffset?.() ?? node.offsetHeight;
	const direction = () => (options.edge === "top" ? -1 : 1);

	function place(offset: number, settling: boolean) {
		const away = dismissOffset();
		const glideMs = placeSheet(
			node,
			direction() * offset,
			direction() * away,
			settling,
		);
		options.onprogress?.(Math.min(offset / away, 1), settling);
		return glideMs;
	}

	function onStart(event: TouchEvent) {
		const touch = event.touches[0];
		tracking =
			options.enabled !== false &&
			event.touches.length === 1 &&
			touch !== undefined &&
			dismissTimer === undefined;
		dragging = false;
		if (!touch) return;
		// SheetChrome scrolls its body, while the drag action stays on the shell.
		scrollTargets = event
			.composedPath()
			.filter(
				(target): target is HTMLElement =>
					target instanceof HTMLElement && node.contains(target),
			);
		startY = lastY = touch.clientY;
		lastTime = event.timeStamp;
		velocity = 0;
	}

	function onMove(event: TouchEvent) {
		const touch = event.touches[0];
		if (!tracking || !touch) return;
		const offset = direction() * (touch.clientY - startY);
		if (!dragging) {
			if (offset === 0) return;
			// The first movement decides: away from the edge, or inside content
			// that can still scroll toward that edge, is a scroll.
			if (
				offset < 0 ||
				scrollTargets.some((target) =>
					options.edge === "top"
						? target.scrollTop + target.clientHeight < target.scrollHeight - 1
						: target.scrollTop > 0,
				)
			) {
				tracking = false;
				return;
			}
			dragging = true;
		}
		event.preventDefault();
		const elapsed = event.timeStamp - lastTime;
		if (elapsed > 0)
			velocity = (direction() * (touch.clientY - lastY)) / elapsed;
		lastY = touch.clientY;
		lastTime = event.timeStamp;
		place(Math.min(Math.max(offset, 0), dismissOffset()), false);
	}

	function onEnd() {
		const wasDragging = dragging;
		tracking = dragging = false;
		if (!wasDragging) return;
		const offset = direction() * (lastY - startY);
		const away = dismissOffset();
		if (offset > away * DISMISS_FRACTION || velocity > FLICK_PX_PER_MS) {
			dismissTimer = setTimeout(() => options.ondismiss(), place(away, true));
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
			if (options.enabled === false) {
				clearTimeout(dismissTimer);
				dismissTimer = undefined;
				place(0, true);
				tracking = dragging = false;
			}
		},
		destroy() {
			clearTimeout(dismissTimer);
			// The dialog outlives its sheet; its next opening starts with a full scrim.
			dialog?.style.removeProperty("--sheet-raised");
			dialog?.style.removeProperty("--sheet-transition");
			node.removeEventListener("touchstart", onStart);
			node.removeEventListener("touchmove", onMove);
			node.removeEventListener("touchend", onEnd);
			node.removeEventListener("touchcancel", onCancel);
		},
	};
};
