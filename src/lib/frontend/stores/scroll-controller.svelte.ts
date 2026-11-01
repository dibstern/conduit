// State machine for chat scroll behavior. Derives scroll state from the chat
// store's LoadLifecycle signal and user input events.

import { tick, untrack } from "svelte";
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
	reposition(step: {
		change?: () => void;
		top: () => number | null;
	}): Promise<void>;
	onNewContent(): void;
	onContainerResize(): void;
	onClearanceChange(delta: number): void;
	onPrepend(prevScrollHeight: number, prevScrollTop: number): void;
}

const DETACH_THRESHOLD = 50; // px from bottom to trigger detach via scroll position
const REFOLLOW_THRESHOLD = 5; // px from bottom to re-follow (tight to prevent accidental re-follow from casual scrolling)

type Intent = "bottom" | "reading" | "holding";
type IntentEvent =
	| { type: "reader"; gap: number; reachedBottom: boolean }
	| { type: "settle"; gap: number }
	| { type: "latest" | "reset" | "hold" | "detach" };

function nextIntent(intent: Intent, event: IntentEvent): Intent {
	switch (event.type) {
		case "reader":
			if (event.reachedBottom) return "bottom";
			return event.gap > DETACH_THRESHOLD ? "reading" : intent;
		case "settle":
			return event.gap < REFOLLOW_THRESHOLD ? "bottom" : "reading";
		case "latest":
		case "reset":
			return "bottom";
		case "hold":
			return "holding";
		case "detach":
			return "reading";
	}
}

/** The scrollport area covered by the turn's sticky controls, including chrome. */
export function turnHeadInset(node: HTMLElement): number {
	const root = node.closest<HTMLElement>('[aria-label="Transcript"]');
	const turn = node.closest<HTMLElement>(".turn-head-card");
	const head = turn?.querySelector<HTMLElement>(".turn-activity-sticky");
	if (!root) return 0;
	const style = getComputedStyle(root);
	const padding = Number.parseFloat(style.scrollPaddingTop) || 0;
	const chrome = Number.parseFloat(
		style.getPropertyValue("--phone-chrome-visible-height"),
	);
	const inset = head
		? Math.max(
				0,
				(Number.parseFloat(style.paddingTop) || 0) +
					(Number.parseFloat(getComputedStyle(head).top) || 0) +
					head.getBoundingClientRect().height,
			)
		: Number.isFinite(chrome)
			? Math.min(padding, chrome)
			: padding;
	return inset;
}

/** Keep a visible target still; expose the start of an oversized target. */
export function turnTargetTop(node: HTMLElement): number | null {
	const root = node.closest<HTMLElement>('[aria-label="Transcript"]');
	if (!root) return null;
	const visibleTop =
		root.getBoundingClientRect().top + root.clientTop + turnHeadInset(node);
	const top = visibleTop + (node.matches(".turn-activity-head") ? 0 : 12);
	const bottom =
		root.getBoundingClientRect().top + root.clientTop + root.clientHeight;
	const revealBottom =
		bottom -
		(Number.parseFloat(getComputedStyle(node).scrollMarginBottom) || 0);
	const box = node.getBoundingClientRect();
	// Opening a row can reveal its neighbouring card at the same time.
	const card = node
		.closest(".turn-head-card")
		?.querySelector<HTMLElement>(
			'.turn-inline-card [data-testid="surfacing-msg-card"]',
		);
	const cardBox = card?.getBoundingClientRect();
	const start =
		cardBox &&
		card !== node &&
		cardBox.top < top &&
		box.bottom - cardBox.top <= revealBottom - top
			? cardBox.top
			: box.top;
	if (start >= visibleTop && box.bottom <= bottom) return null;
	return (
		root.scrollTop +
		(start < top || box.height > revealBottom - top
			? start - top
			: box.bottom - revealBottom)
	);
}

export function anchorTop(row: Element, before: number): number | null {
	const root = row.closest<HTMLElement>('[aria-label="Transcript"]');
	return root && row.isConnected
		? root.scrollTop + row.getBoundingClientRect().top - before
		: null;
}

export async function repositionWithoutController(
	root: HTMLElement | undefined,
	step: Parameters<ScrollController["reposition"]>[0],
): Promise<void> {
	step.change?.();
	if (!root) return;
	await tick();
	const top = step.top();
	if (top !== null) root.scrollTop = top;
}

export function createScrollController(
	getLifecycle: () => LoadLifecycle,
	getNavigation: () => {
		historical: boolean;
		busy: boolean;
		topClearance: number;
		identity: number;
	} = () => ({ historical: false, busy: false, topClearance: 0, identity: 0 }),
	{ onReaderFollow }: { onReaderFollow?: () => void } = {},
): ScrollController {
	let container: HTMLElement | null = null;
	let intent = $state<Intent>("bottom");
	let lastWrite: number | null = null;
	let resetTimerScheduled = false; // guards against scheduling multiple reset frames
	let repositionSequence = 0;
	let activeMessageId = $state<string | null>(null);
	let selectedTop: number | null = null;
	let mutation: MutationObserver | undefined;
	let resize: ResizeObserver | undefined;
	const observed = new Set<Element>();
	let measureFrame: { handle?: number } | null = null;
	let attachment = 0;
	let extent = 0;
	let gap = $state(0);
	let extentFloor = Number.POSITIVE_INFINITY;
	let seenTop = 0;

	function observe(resetFloor = false): void {
		extent = container
			? Math.max(0, container.scrollHeight - container.clientHeight)
			: 0;
		gap = extent - (container?.scrollTop ?? 0);
		extentFloor = resetFloor ? extent : Math.min(extentFloor, extent);
	}

	function apply(event: IntentEvent): void {
		intent = nextIntent(intent, event);
	}

	function settle(): void {
		observe();
		apply({ type: "settle", gap });
	}

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
		const nearBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight <
			REFOLLOW_THRESHOLD;
		let row = rows[0];
		for (const candidate of rows) {
			if (!nearBottom && candidate.getBoundingClientRect().top > threshold)
				break;
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
			const previousExtent = extent;
			observe();
			followIfContentFits();
			// A reader's queued scroll can increase the gap without layout growth.
			// Follow only a larger scrollable extent, before its scroll event lands.
			if (extent > previousExtent && getState() === "following")
				scrollToBottom();
			scheduleMeasure();
		});
	}

	function getState(): ScrollState {
		const lc = getLifecycle();
		if (lc === "empty" || lc === "loading") return "loading";
		if (
			intent !== "bottom" ||
			getNavigation().historical ||
			getNavigation().busy
		)
			return "detached";
		return "following";
	}

	function scrollToBottom(): void {
		if (!container || getNavigation().historical || getNavigation().busy)
			return;
		write(container.scrollHeight);
	}

	function write(top: number): void {
		if (!container) return;
		container.scrollTop = top;
		lastWrite = container.scrollTop;
		observe(true);
		// Expire the expected position on the next frame. A frame dispatches
		// scroll events before rAF callbacks, so this lands after our own event.
		// setTimeout(0) can run before the frame; rows that render in between
		// would then make our own scroll read as the reader leaving the bottom.
		if (!resetTimerScheduled) {
			resetTimerScheduled = true;
			const epoch = attachment;
			requestAnimationFrame(() => {
				if (epoch !== attachment) return;
				lastWrite = null;
				resetTimerScheduled = false;
			});
		}
	}

	function followIfContentFits(): boolean {
		// A shrink at scrollTop zero emits no scroll. Pending reveals settle
		// their own position once expansion and placement have finished.
		if (
			!container ||
			intent !== "reading" ||
			container.scrollHeight > container.clientHeight
		)
			return false;
		settle();
		return true;
	}

	function onScroll(): void {
		scheduleMeasure();
		if (!container) return;

		// Writes and user input can coalesce into one event. Only ignore it
		// while the position still matches our write, including browser clamping.
		const top = container.scrollTop;
		const previousTop = seenTop;
		seenTop = top;
		if (top === lastWrite) return;
		lastWrite = null;
		// Read after the guards: our own scrolls record their layout, and reading here
		// would absorb growth that landed before this queued event.
		observe();
		if (previousTop > extent && top === extent) settle();
		else if (!followIfContentFits()) {
			const wasFollowing = getState() === "following";
			const reachedBottom =
				gap < REFOLLOW_THRESHOLD ||
				Math.abs(extentFloor - top) < REFOLLOW_THRESHOLD;
			apply({ type: "reader", gap, reachedBottom });
			if (reachedBottom && gap > 0) scrollToBottom();
			if (!wasFollowing && getState() === "following") onReaderFollow?.();
		}
		observe(true);
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
			return gap < REFOLLOW_THRESHOLD;
		},

		get activeMessageId() {
			return activeMessageId;
		},
		place(target): boolean {
			if (!container) return false;
			if (target === "latest") {
				const wasBottom = intent === "bottom";
				apply({ type: "latest" });
				write(container.scrollHeight);
				if (!wasBottom) onReaderFollow?.();
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
			const top =
				container.scrollTop +
				element.getBoundingClientRect().top -
				container.getBoundingClientRect().top -
				container.clientTop -
				getNavigation().topClearance -
				20;
			write(top);
			settle();
			selectedTop =
				Math.abs(container.scrollTop - top) > 1 ? container.scrollTop : null;
			activeMessageId = target.messageId;
			return true;
		},

		attach(el: HTMLElement): void {
			attachment++;
			container = el;
			observe(true);
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
			lastWrite = null;
			resetTimerScheduled = false;
			repositionSequence++;
			apply({ type: "detach" });
			if (container) {
				container.removeEventListener("scroll", onScroll);
				container = null;
			}
		},

		resetForSession(): void {
			activeMessageId = null;
			selectedTop = null;
			repositionSequence++;
			apply({ type: "reset" });
			// Scroll immediately so the first paint of the new session is at the
			// bottom, not at whatever scroll position the previous session had.
			scrollToBottom();
		},

		async reposition(step): Promise<void> {
			const sequence = ++repositionSequence;
			apply({ type: "hold" });
			try {
				step.change?.();
				await tick();
				if (sequence !== repositionSequence) return;
				const top = step.top();
				if (top !== null) write(top);
			} finally {
				if (sequence === repositionSequence) settle();
			}
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
		// fire a scroll event. Re-pin through scrollToBottom() so the resulting
		// position is recognised as our write rather than user intent.
		// This is the single most likely thing a future reader deletes as redundant.
		onContainerResize(): void {
			if (getState() === "following") scrollToBottom();
		},

		onClearanceChange(delta): void {
			if (!container) return;
			if (gap < REFOLLOW_THRESHOLD) {
				if (getState() === "following") scrollToBottom();
			} else write(container.scrollTop + delta);
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
				write(prevScrollTop + (newScrollHeight - prevScrollHeight));
			});
		},
	};
}
