// ─── Table Scroll Shadows ────────────────────────────────────────────────────
// Attaches scroll-position-aware shadow affordances to table scroll containers
// produced by the custom marked renderer in markdown.ts.
//
// The renderer emits:
//   <div class="table-scroll-container">
//     <div class="table-scroll">…</div>
//     <div class="table-shadow table-shadow-left"></div>
//     <div class="table-shadow table-shadow-right"></div>
//   </div>
//
// This module finds those containers and wires up scroll + resize listeners
// so the shadows appear/disappear based on whether content extends beyond
// each edge. Returns a cleanup function for proper resource management.

/**
 * Toggle shadow visibility based on the current scroll position.
 * - Right shadow: visible when content extends beyond the right edge.
 * - Left shadow: visible when the user has scrolled away from the start.
 * - Neither: when the table fits without scrolling.
 */
function updateShadows(
	scroll: HTMLElement,
	shadowLeft: HTMLElement,
	shadowRight: HTMLElement,
): void {
	const { scrollLeft, scrollWidth, clientWidth } = scroll;
	shadowLeft.classList.toggle("visible", scrollLeft > 1);
	shadowRight.classList.toggle(
		"visible",
		scrollLeft + clientWidth < scrollWidth - 1,
	);
}

/**
 * Attach scroll and resize listeners to every `.table-scroll-container`
 * inside `root`. Returns a cleanup function that disconnects all observers
 * and removes all listeners.
 *
 * Also usable as a Svelte action (`use:initTableScrollShadows`).
 * When used as an action, Svelte calls the returned `destroy` automatically.
 */
export function initTableScrollShadows(root: HTMLElement): {
	destroy: () => void;
} {
	const cleanups: (() => void)[] = [];

	const containers = root.querySelectorAll(".table-scroll-container");
	for (const container of containers) {
		const scroll = container.querySelector<HTMLElement>(".table-scroll");
		const shadowLeft =
			container.querySelector<HTMLElement>(".table-shadow-left");
		const shadowRight = container.querySelector<HTMLElement>(
			".table-shadow-right",
		);
		if (!scroll || !shadowLeft || !shadowRight) continue;

		// Skip if already initialised (idempotency guard)
		if (scroll.dataset["shadowsInit"]) continue;
		scroll.dataset["shadowsInit"] = "1";

		const onUpdate = () => updateShadows(scroll, shadowLeft, shadowRight);

		scroll.addEventListener("scroll", onUpdate, { passive: true });

		// Initial state — deferred so the table has been laid out
		requestAnimationFrame(onUpdate);

		// Re-check on resize (e.g. sidebar toggle changes available width)
		let ro: ResizeObserver | undefined;
		if (typeof ResizeObserver !== "undefined") {
			ro = new ResizeObserver(onUpdate);
			ro.observe(scroll);
		}

		cleanups.push(() => {
			scroll.removeEventListener("scroll", onUpdate);
			ro?.disconnect();
		});
	}

	return {
		destroy() {
			for (const fn of cleanups) fn();
			cleanups.length = 0;
		},
	};
}
