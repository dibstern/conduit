/**
 * Story frames: temporary #storybook-root geometry, applied in a story's
 * `beforeEach` and undone by the cleanup it returns.
 *
 * A frame exists when a component's real anchoring comes from a parent it does
 * not have in isolation. Rendering such a component bare does not merely look
 * wrong — it can place the entire component outside the captured area, which
 * produces a blank baseline that then compares equal forever. See
 * conduit-test-7jv.
 */

/**
 * Frame for a menu that opens UPWARD from its anchor (`absolute bottom-full`),
 * the way FileMenu and CommandMenu open above the composer.
 *
 * `bottom: 100%` positions the menu entirely above its containing block, so
 * with no positioned ancestor the containing block is the viewport and the menu
 * lands at negative y — fully off-screen. The component's own wrapper has no
 * height either, so the harness sees a zero-height root, falls back to a
 * viewport capture, and photographs an empty page. That is how 20 committed
 * baselines came to hold one to four distinct colours.
 *
 * Making the root the containing block and pushing it down the page puts the
 * menu back on screen, in the same relationship to its anchor that the composer
 * gives it.
 *
 * @param clearance space above the root for the menu to occupy; must exceed the
 * menu's max height (300px) plus its margin, or the top of the menu is clipped.
 */
export function menuOpensUpwardFrame(clearance = 340): () => void {
	const root = document.getElementById("storybook-root");
	const previous = root?.getAttribute("style") ?? null;
	root?.setAttribute(
		"style",
		`position:relative;margin-top:${clearance}px;box-sizing:border-box`,
	);
	return () => {
		if (previous === null) {
			root?.removeAttribute("style");
		} else {
			root?.setAttribute("style", previous);
		}
	};
}
