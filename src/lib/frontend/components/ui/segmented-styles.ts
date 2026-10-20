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
 * Settings' joined segment follows the Final design. The other recipes retain
 * their original call-site appearance.
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
	 * A horizontal tab header: an underline drawn with a bottom border that is
	 * pulled up over the strip's own rule by `-mb-px`. Tabs' default look; it
	 * was SettingsPanel's header until frame H moved Settings to `sections`.
	 *
	 * The as-found version also carried `border-none`, and that was a live bug:
	 * `border-none` sets border-style to none, which kills `border-b-2` outright,
	 * so the underline never rendered from the classes at all. Someone had
	 * patched around it with an inline `style="border-bottom: ..."`, leaving the
	 * conditional `border-accent` class as dead code that contradicted the
	 * element's own style attribute. Dropping `border-none` makes the classes
	 * load-bearing again and the inline style unnecessary — Tailwind v4's
	 * preflight already sets `border: 0 solid`, so `border-b-2` alone is a solid
	 * 2px bottom border.
	 */
	underline: {
		list: "flex border-b border-border px-5 gap-1 font-sans",
		// A whole-pixel line box (text-sm's 1.4 gives 15.4px) keeps the strip,
		// and the scrolling panel below it, on the pixel grid.
		item: "px-3 py-2 text-sm leading-[15px] font-medium border-b-2 -mb-px transition-colors cursor-pointer bg-transparent",
		selected: "border-accent text-text",
		unselected: "border-transparent text-text-muted hover:text-text",
	},
	/** Final's filled capsules, used for DiffView's Unified/Split switch. */
	pill: {
		list: "diff-toggle-bar flex shrink-0 items-center gap-[2px] rounded-full bg-chip",
		item: "relative flex h-[24px] items-center rounded-full px-[9px] text-[12px] font-medium cursor-pointer font-sans transition-colors duration-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text before:absolute before:inset-x-0 before:top-1/2 before:-translate-y-1/2 before:content-[''] max-md:before:h-[44px]",
		selected: "bg-accent/16 text-accent",
		unselected: "text-text-muted hover:text-text",
	},
	/** Final settings segments: a chip track and raised neutral selection. */
	joined: {
		list: "inline-flex max-w-full shrink-0 rounded-[8px] bg-chip p-[2px]",
		item: "flex min-h-[24px] items-center justify-center rounded-[6px] px-[10px] text-[12px] font-medium max-md:min-h-[44px] cursor-pointer transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text disabled:opacity-50 disabled:cursor-not-allowed",
		selected: "bg-settings-segment text-text shadow-settings-segment",
		unselected: "text-text-secondary hover:text-text",
	},
	avatar: {
		list: "flex w-full rounded-[10px] bg-chip p-[3px]",
		item: "flex min-h-[28px] max-md:min-h-[44px] flex-1 items-center justify-center rounded-[8px] px-[6px] text-[13px] font-medium cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text",
		selected: "bg-settings-segment text-text shadow-settings-segment",
		unselected: "text-text-secondary hover:text-text",
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
		list: "flex flex-col items-center gap-[6px] py-[10px]",
		item: "relative flex h-[32px] w-[32px] items-center justify-center rounded-[9px] text-base cursor-pointer transition-colors",
		selected: "bg-accent/16 text-accent",
		unselected: "text-text-dimmer hover:text-text disabled:opacity-50",
	},
	/**
	 * Final settings rail. On phones, Tabs groups the navigation rows into
	 * cards and selection pushes a page.
	 */
	sections: {
		list: "flex flex-col",
		item: "group flex w-full min-h-[32px] items-center gap-[9px] rounded-[8px] px-[10px] text-left text-[13px] leading-[18px] max-md:min-h-[48px] max-md:gap-[12px] max-md:rounded-none max-md:px-[14px] max-md:text-[15px] cursor-pointer transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text disabled:opacity-50",
		selected: "bg-selection text-text font-medium max-md:bg-settings-card",
		unselected: "text-text-secondary hover:text-text max-md:text-text",
	},
	/**
	 * chat/SurfacingCard's level control on the strip axis. Painted at the
	 * axis's 21px; a transparent ::before takes the tap at 44px on phones, so
	 * the chip track does not grow into a lozenge.
	 */
	level: {
		list: "inline-flex rounded-[8px] bg-chip p-[2px]",
		item: "relative inline-flex h-[21px] items-center gap-[4px] rounded-[6px] px-[6px] font-sans text-[11.5px] font-medium cursor-pointer transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text before:absolute before:inset-x-0 before:top-1/2 before:-translate-y-1/2 before:content-[''] max-md:before:h-[44px]",
		selected: "bg-bg text-text shadow-settings-segment",
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
	/** Shown instead of `label` below md; the accessible name stays `label`. */
	shortLabel?: string;
	/** A quiet trailing figure, such as a count. Not part of the accessible name. */
	detail?: string;
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
