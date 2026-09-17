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

	/** Phone-width viewport: the session bar replaces the global header. */
	compact:
		typeof matchMedia === "function"
			? matchMedia(COMPACT_QUERY).matches
			: false,
});

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
