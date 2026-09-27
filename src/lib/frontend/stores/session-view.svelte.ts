// ─── Session View Store ─────────────────────────────────────────────────────
// State the session's own chrome needs but the transcript owns. Kept in one
// place so the bar and the message list cannot disagree.

/**
 * 767px is Tailwind's `md` breakpoint minus one, so this agrees with every
 * `md:` utility rather than with the app's older ad-hoc `<= 768` checks.
 */
const COMPACT_QUERY = "(max-width: 767px)";

export const sessionViewState = $state({
	/** Published by MessageList from its scroll controller. Loading and settling
	 *  count as at-bottom while the transcript is hydrating. */
	atBottom: true,

	/** The chevron's override: the bar stays expanded even at the bottom. Starts
	 *  true so a fresh load arrives with the full bar on screen. */
	forcedOpen: true,

	/** Phone-width viewport: the session bar replaces the global header. */
	compact:
		typeof matchMedia === "function"
			? matchMedia(COMPACT_QUERY).matches
			: false,
});

/**
 * The collapse rule, derived rather than stored so the bar and the transcript
 * cannot disagree about it. `forcedOpen` is its only mutable input.
 */
export function isBarCollapsed(): boolean {
	return (
		sessionViewState.compact &&
		sessionViewState.atBottom &&
		!sessionViewState.forcedOpen
	);
}

/**
 * The only path by which `atBottom` is written from outside the store. It exists
 * because the false->true edge is what clears the force, and an edge cannot be
 * observed by a plain assignment at the call site.
 *
 * The edge is read off a private non-reactive copy, not off `atBottom` itself:
 * the caller is a Svelte `$effect`, and reading the same state it writes would
 * make that effect re-run itself once on every publish.
 */
let lastAtBottom = true;
export function publishAtBottom(next: boolean): void {
	if (next && !lastAtBottom) sessionViewState.forcedOpen = false;
	lastAtBottom = next;
	sessionViewState.atBottom = next;
}

/** The chevron. Expands the bar without moving the transcript. */
export function forceBarOpen(): void {
	sessionViewState.forcedOpen = true;
}

// A scroll-up smaller than the controller's 50px detach threshold never flips
// atBottom. Without this, a small nudge could leave a forced-open bar stuck open
// indefinitely, because there is no rising edge to clear the force.
export function noteUserScroll(): void {
	sessionViewState.forcedOpen = false;
}

/** Arrive at a new session with the full bar open, whatever the last one did. */
export function noteSessionChanged(): void {
	sessionViewState.forcedOpen = true;
}

/**
 * Track the compact breakpoint. One listener for the whole app — call it from
 * the layout and dispose with the returned teardown.
 */
export function watchCompactViewport(): () => void {
	if (typeof matchMedia !== "function") return () => {};
	const query = matchMedia(COMPACT_QUERY);
	sessionViewState.compact = query.matches;
	const onChange = (event: MediaQueryListEvent) => {
		sessionViewState.compact = event.matches;
	};
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}
