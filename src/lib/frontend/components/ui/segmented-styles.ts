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
 * One convergence has since landed. The three strips
 * marked their selected option in two different colours: `pill` used `accent`
 * while `underline` and `field` used `brand-a`. Those two tokens hold the same
 * value in both canonical themes (#ff2d7b dark, #c9004f light), so the split
 * was invisible on screen and the swap below is zero-diff -- but they are
 * separate names that the queued palette work may give separate values, and
 * then the split would become a real inconsistency nobody chose. `accent` wins
 * because selection is an interactive state and `accent` is the token family
 * that models one (it has `--color-accent-hover` and `--color-accent-bg`;
 * `brand-a` is a bare swatch for glows and identity marks). The token
 * duplication remains unresolved (tracked in conduit-test-57oe).
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
	/** P2 effort choices, with a neutral selected fill in both themes. */
	picker: {
		list: "flex flex-1 min-w-0 gap-[3px]",
		item: "flex-1 min-w-0 rounded-[7px] py-1.5 px-0.5 text-xs cursor-pointer transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text disabled:opacity-50",
		selected: "bg-text text-bg font-semibold",
		unselected: "bg-border-subtle text-text-muted hover:text-text",
	},
	/** Context windows keep their content width within the same picker row. */
	"picker-context": {
		list: "flex flex-1 min-w-0 flex-wrap gap-0.5",
		item: "rounded-[7px] py-0.5 px-2 text-xs cursor-pointer transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text disabled:opacity-50",
		selected: "bg-text text-bg font-semibold",
		unselected: "text-text-muted hover:text-text",
	},
	/**
	 * A horizontal tab header: an underline drawn with a bottom border that is
	 * pulled up over the strip's own rule by `-mb-px`. Tabs' default look; it
	 * was SettingsPanel's header until frame H moved Settings to `sections`.
	 *
	 * The as-found version also carried `border-none`, and that was a live bug:
	 * `border-none` sets border-style to none, which kills `border-b-2` outright,
	 * so the underline never rendered from the classes at all. Someone had
	 * patched around it with an inline `style="border-bottom: ..."`, leaving the
	 * conditional `border-brand-a` class as dead code that contradicted the
	 * element's own style attribute. Dropping `border-none` makes the classes
	 * load-bearing again and the inline style unnecessary — Tailwind v4's
	 * preflight already sets `border: 0 solid`, so `border-b-2` alone is a solid
	 * 2px bottom border.
	 */
	underline: {
		list: "flex border-b border-border px-5 gap-1 font-brand",
		// A whole-pixel line box (text-sm's 1.4 gives 15.4px) keeps the strip,
		// and the scrolling panel below it, on the pixel grid.
		item: "px-3 py-2 text-sm leading-[15px] font-medium border-b-2 -mb-px transition-colors cursor-pointer bg-transparent",
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
	/** Full-width session view band, with literal 44px phone targets. */
	switcher: {
		list: "flex w-full min-w-0 gap-1 rounded-lg bg-bg-alt p-0.5",
		item: "flex min-w-0 min-h-[44px] flex-1 items-center justify-center gap-1 rounded-md px-1 text-sm font-medium cursor-pointer transition-colors",
		selected: "bg-bg-surface text-text shadow-sm",
		unselected: "text-text-muted hover:text-text disabled:opacity-50",
	},
	/** Compact vertical dock beside desktop panes. */
	rail: {
		list: "flex flex-col items-center gap-1 py-1",
		item: "relative flex h-[32px] w-[32px] items-center justify-center rounded-md text-base cursor-pointer transition-colors",
		selected: "bg-bg-alt text-text",
		unselected: "text-text-muted hover:text-text disabled:opacity-50",
	},
	/**
	 * overlays/SettingsPanel's left section list (frame H): a vertical Tabs
	 * whose selected row takes the alt fill. Full-width rows, so the whole
	 * line is the hit target. On a phone the list is a whole screen you drill
	 * in from, so rows grow to a 44px thumb target and a step larger type.
	 */
	sections: {
		list: "flex flex-col gap-[2px]",
		item: "w-full text-left px-[8px] py-[6px] rounded-[7px] text-[11.5px] leading-[15px] max-md:flex max-md:items-center max-md:min-h-[44px] max-md:text-[13px] cursor-pointer transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text disabled:opacity-50",
		selected: "bg-bg-alt text-text",
		unselected: "text-text-secondary hover:text-text",
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
	shortcut?: string;
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
