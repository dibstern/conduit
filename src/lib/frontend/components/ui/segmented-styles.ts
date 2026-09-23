/**
 * Appearance recipes for the one-of-N strips: ui/Tabs and ui/SegmentedControl.
 *
 * A plain module rather than `<script module>` on either component, for the
 * same reason button-recipes.ts is one: the root tsconfig resolves `*.svelte`
 * through an ambient shim that exposes only the default export, so nothing
 * under `test/` can import a named export from a component file.
 *
 * Both components share this map because the three looks are the same idea in
 * three costumes, and because a strip should not change appearance when its
 * semantics are corrected. What they do NOT share is the accessibility
 * contract, which is why they are two components rather than one with a
 * `semantics` prop — see the header of ui/Tabs.svelte.
 *
 * Every recipe below started as the as-found class list of a real call site,
 * token for token, so the migration was zero-diff by construction.
 *
 * One convergence has since landed (conduit-test-de3.6). The three strips
 * marked their selected option in two different colours: `pill` used `accent`
 * while `underline` and `field` used `brand-a`. Those two tokens hold the same
 * value in both canonical themes (#ff2d7b dark, #c9004f light), so the split
 * was invisible on screen and the swap below is zero-diff -- but they are
 * separate names that the queued palette work may give separate values, and
 * then the split would become a real inconsistency nobody chose. `accent` wins
 * because selection is an interactive state and `accent` is the token family
 * that models one (it has `--color-accent-hover` and `--color-accent-bg`;
 * `brand-a` is a bare swatch for glows and identity marks). The token
 * duplication itself is conduit-test-57oe's problem, not this file's.
 *
 * What is NOT converged, deliberately: `pill` stays content-width with a
 * border-colour hover and `field` stays `flex-1` with none, because one is a
 * compact toolbar switch and the other fills a form row. Different containers,
 * different geometry.
 */

type SegmentedRecipe = {
	/** On the strip element itself. */
	list: string;
	/** On every option, selected or not. */
	item: string;
	selected: string;
	unselected: string;
};

export const SEGMENTED_VARIANTS = {
	/**
	 * overlays/SettingsPanel's five-tab header. An underline drawn with a
	 * bottom border that is pulled up over the strip's own rule by `-mb-px`.
	 *
	 * The as-found version also carried `border-none`, and that was a live bug:
	 * `border-none` sets border-style to none, which kills `border-b-2` outright,
	 * so the underline never rendered from the classes at all. Someone had
	 * patched around it with an inline `style="border-bottom: ..."`, leaving the
	 * conditional `border-brand-a` class as dead code that contradicted the
	 * element's own style attribute. Dropping `border-none` makes the classes
	 * load-bearing again and the inline style unnecessary — Tailwind v4's
	 * preflight already sets `border: 0 solid`, so `border-b-2` alone is a solid
	 * 2px bottom border (conduit-test-mkah).
	 */
	underline: {
		list: "flex border-b border-border px-5 gap-1 font-brand",
		item: "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer bg-transparent",
		selected: "border-accent text-text",
		unselected: "border-transparent text-text-muted hover:text-text",
	},
	/**
	 * chat/DiffView's Unified/Split switch. The only variant whose unselected
	 * hover moves a BORDER colour rather than a background, which is precisely
	 * why ui/Button could never express it: `hoverFill` is a background union.
	 */
	pill: {
		list: "diff-toggle-bar flex items-center gap-1 px-3 py-1 mb-1",
		item: "text-xs px-2 py-1 rounded border cursor-pointer font-sans transition-colors duration-100",
		selected: "bg-accent/20 border-accent/40 text-accent font-medium",
		unselected:
			"bg-transparent border-border text-text-dimmer hover:text-text hover:border-border-subtle",
	},
	/**
	 * overlays/SettingsPanel's Claude/OpenCode driver picker. Sits inside a
	 * bordered form card, so its options are equal-width (`flex-1`) fields
	 * rather than content-width tabs.
	 */
	field: {
		list: "flex gap-1.5",
		item: "flex-1 px-3 py-1.5 text-xs rounded border transition-colors cursor-pointer",
		selected: "border-accent text-text bg-accent/10",
		unselected: "border-border text-text-muted hover:text-text",
	},
} as const satisfies Record<string, SegmentedRecipe>;

export type SegmentedVariant = keyof typeof SEGMENTED_VARIANTS;

export const SEGMENTED_VARIANT_NAMES = Object.keys(
	SEGMENTED_VARIANTS,
) as SegmentedVariant[];

/**
 * One option in a strip. Generic so a call site holding a narrowed union
 * (`"claude" | "opencode"`) keeps it: widening every consumer's state to
 * `string` to fit the primitive would be the primitive taxing the caller.
 */
export type SegmentedOption<T extends string = string> = {
	value: T;
	label: string;
	/** Forwarded as `data-testid`; several call sites' e2e page objects need it. */
	testId?: string;
	disabled?: boolean;
};

/**
 * Shared by both components so the selected/unselected split is decided in one
 * place. Returns a single class string; ORDER within it is irrelevant, since
 * two utilities in the same Tailwind group collide on stylesheet order.
 */
export const segmentedItemClass = (
	variant: SegmentedVariant,
	isSelected: boolean,
	className?: string,
): string => {
	const recipe = SEGMENTED_VARIANTS[variant];
	return [
		recipe.item,
		isSelected ? recipe.selected : recipe.unselected,
		className,
	]
		.filter(Boolean)
		.join(" ");
};
