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

/**
 * Separate values for `style:` directives: a whole `style` attribute would be
 * rewritten on every frame, wiping the variables that belowHeader sets.
 */
export const sheetScrimStyle = ({
	progress,
	settling,
}: {
	progress: number;
	settling: boolean;
}) => ({
	opacity: String(1 - progress),
	transition: settling ? `opacity ${SETTLE_MS}ms linear` : "none",
});

/**
 * Offsets a sheet `offset` px from its resting place, of `away` px to be put
 * away, gliding there when `settling`. Its dialog gets --sheet-raised, 1 at rest
 * and 0 put away, and --sheet-transition, so the scrim and anything else styled
 * from them move with the sheet. Returns how long the glide takes: nothing when
 * the sheet is already there. `transform` replaces the offset's translation.
 */
export function placeSheet(
	node: HTMLElement,
	offset: number,
	away: number,
	settling: boolean,
	transform = offset !== 0 ? `translateY(${offset}px)` : "",
): number {
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

/**
 * --sheet-top is the header's bottom edge, --sheet-left and --sheet-right its column's insets, all measured
 * in the fixed node's containing block: the viewport, or an ancestor that contains fixed boxes (offsetParent).
 */
function placeBelow(node: HTMLElement, header: HTMLElement): void {
	const column = (
		header.closest("#app, #sidebar") ?? header
	).getBoundingClientRect();
	const frame = node.offsetParent?.getBoundingClientRect() ?? {
		top: 0,
		left: 0,
		right: document.documentElement.clientWidth,
	};
	node.style.setProperty(
		"--sheet-top",
		`${Math.max(0, header.getBoundingClientRect().bottom - frame.top)}px`,
	);
	node.style.setProperty("--sheet-left", `${column.left - frame.left}px`);
	node.style.setProperty("--sheet-right", `${frame.right - column.right}px`);
}

/** Re-place `node` whenever the live header (the session's, else the list's) moves or changes. */
function followHeader(node: HTMLElement): () => void {
	let header: Element | undefined;
	const observer = new ResizeObserver(() => measure());
	const measure = () => {
		const live = ["session-bar", "sidebar-header"]
			.map((id) => document.getElementById(id))
			.find((element) => element?.getClientRects().length);
		if (!live) return;
		if (live !== header) {
			observer.disconnect();
			observer.observe(live);
			header = live;
		}
		placeBelow(node, live);
	};
	measure();
	const listening = new AbortController();
	window.addEventListener("resize", measure, { signal: listening.signal });
	window.addEventListener("scroll", measure, {
		capture: true,
		signal: listening.signal,
	});
	// The last place stays set, so a layer closing after this keeps it.
	return () => {
		observer.disconnect();
		listening.abort();
	};
}

/**
 * While active, keeps a floating layer under the live header and inside that
 * header's column. The .below-header utility applies the variables it sets.
 */
export const belowHeader: Action<HTMLElement, boolean> = (node, initial) => {
	let stop = initial ? followHeader(node) : undefined;
	return {
		update(active) {
			stop?.();
			stop = active ? followHeader(node) : undefined;
		},
		destroy: () => stop?.(),
	};
};

/** The control that opened `node`: its own trigger, else one outside it whose aria-controls names the sheet or its content. */
function openerOf(
	node: HTMLElement,
	trigger: HTMLElement | null,
): HTMLElement | null {
	return (
		trigger ??
		Array.from(document.querySelectorAll<HTMLElement>("[aria-controls]")).find(
			(control) =>
				node.contains(
					document.getElementById(control.getAttribute("aria-controls") ?? ""),
				),
		) ??
		null
	);
}

/**
 * On a phone or Duo a resting sheet is put away into the control that opened
 * it, wherever that sits: scaled about the control's centre down to its size.
 * On a desktop, with no control on screen, or once a finger has moved it, there
 * is no such transform and the sheet glides behind the header.
 */
function intoTrigger(
	node: HTMLElement,
	trigger: HTMLElement | null,
): string | undefined {
	const box =
		trigger?.closest("#layout:not([data-pose='desktop'])") &&
		trigger.getClientRects()[0];
	if (!trigger || !box || node.style.transform !== "") return undefined;
	// Only the visible part: the phone task row scrolls a button wider than itself.
	let clip = { left: 0, right: innerWidth };
	for (let el = trigger.parentElement; el; el = el.parentElement)
		if (/auto|scroll/.test(getComputedStyle(el).overflowX)) {
			clip = el.getBoundingClientRect();
			break;
		}
	const left = Math.max(box.left, clip.left, 0);
	const width = Math.min(box.right, clip.right, innerWidth) - left;
	const sheet = node.getBoundingClientRect();
	node.style.transformOrigin = `${left + width / 2 - sheet.left}px ${box.top + box.height / 2 - sheet.top}px`;
	return `scale(${Math.min(1, Math.max(width / sheet.width, box.height / sheet.height))})`;
}

/**
 * Hold the DOM through the same CSS glide used when a finger releases it, or
 * off the desktop grow out of and shrink back into `trigger`, measured each time.
 */
export function sheetGlide(
	node: HTMLElement,
	{
		edge,
		onprogress,
		trigger,
	}: Pick<DragToDismissOptions, "edge" | "onprogress"> & {
		trigger: () => HTMLElement | null;
	},
): (options?: { direction: "in" | "out" }) => TransitionConfig {
	return ({ direction } = { direction: "in" }) => {
		if (edge !== "top") return { duration: 0 };
		const away = -node.offsetHeight;
		const putAway = intoTrigger(node, openerOf(node, trigger()));
		if (direction === "out") {
			onprogress?.(1, true);
			return { duration: placeSheet(node, away, away, true, putAway) };
		}
		placeSheet(node, away, away, false, putAway);
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
		// Only real scrollers count: an overflow-hidden shell still reports the
		// height of whatever its scrolling body holds.
		scrollTargets = event
			.composedPath()
			.filter(
				(target): target is HTMLElement =>
					target instanceof HTMLElement &&
					node.contains(target) &&
					/auto|scroll/.test(getComputedStyle(target).overflowY),
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
