// The four `data-[side=...]` shadows are one per placement, so exactly one
// ever applies -- no two utilities from the shadow group can collide.
//
// `left` and `right` were missing until ui/Tooltip got its first real consumer
// (conduit-test-ee6y, the instance rail). A side-anchored surface simply had
// no elevation at all, which nobody had noticed because nothing had ever asked
// for one. They take `shadow-panel` rather than a horizontal offset because no
// such token exists: menu casts up (-4px) for surfaces opening above, dropdown
// casts down (8px) for surfaces opening below, and panel's mild 4px is the
// neutral one. That is also, independently, what the hand-written rail tooltip
// had been using, which is the kind of agreement worth taking as an answer.
// Everything every floating surface agrees on. Deliberately emits NO
// border-radius and NO z-index, because neither is invariant: the portaled
// overlays sit at the popover tier, the inline detached listboxes sit two
// tiers below at the dropdown tier, and two of those listboxes wear a wider
// radius than the rest. Baking either in made the shared constant emit a
// utility half its consumers had to beat with a Tailwind `!`, which is the
// primitive losing an argument it started (conduit-test-llxm).
const FLOATING_SURFACE_BASE_CLASSES =
	"border border-border bg-bg-alt py-1 " +
	"focus-visible:outline-hidden " +
	"data-[side=top]:shadow-menu data-[side=bottom]:shadow-dropdown " +
	"data-[side=left]:shadow-panel data-[side=right]:shadow-panel";

// A closed union that REPLACES the surface's radius rather than appending to
// it, so exactly one `rounded-*` is ever emitted. `xl` exists because
// CommandMenu and FileMenu both wear it; whether they should is
// conduit-test-de3.6's question, not this constant's.
export const FLOATING_SURFACE_RADIUS_CLASSES = {
	lg: "rounded-lg",
	xl: "rounded-xl",
} as const;

export type FloatingSurfaceRadius =
	keyof typeof FLOATING_SURFACE_RADIUS_CLASSES;

// The portaled overlays: Popover, Menu, Tooltip. They float above everything,
// including the dropdowns.
export const FLOATING_SURFACE_CLASSES =
	`${FLOATING_SURFACE_BASE_CLASSES} ${FLOATING_SURFACE_RADIUS_CLASSES.lg} ` +
	"z-[var(--z-popover)]";

// The inline detached listboxes: CommandMenu, FileMenu, DirectoryAutocomplete.
// All three are anchored inside the composer or a form rather than portaled,
// and all three independently chose the dropdown tier, so it is the default
// here rather than something each one re-states. Radius is the caller's.
export const DETACHED_LISTBOX_SURFACE_CLASSES = `${FLOATING_SURFACE_BASE_CLASSES} z-[var(--z-dropdown)]`;

export const FLOATING_MENU_CONTENT_CLASSES = `${FLOATING_SURFACE_CLASSES} max-h-[var(--bits-dropdown-menu-content-available-height)] overflow-y-auto`;

export const FLOATING_TOOLTIP_CLASSES = `${FLOATING_SURFACE_CLASSES} max-w-xs px-2 text-xs text-text`;

export const FLOATING_ITEM_PADDING_CLASSES = "px-3 py-1.5";

export const MENU_ITEM_VARIANT_CLASSES = {
	default: "text-text",
	danger: "text-error",
} as const;

export const MENU_RADIO_ITEM_COLOR_CLASSES =
	"data-[state=unchecked]:text-text data-[state=checked]:text-accent";

// Everything a menu row is regardless of how tightly it is packed. Emits no
// `gap-*` and no padding, so the density recipe below owns that group outright.
export const FLOATING_ITEM_BASE_CLASSES =
	"flex cursor-default select-none items-center text-sm " +
	"hover:bg-bg focus:bg-bg focus:outline-hidden " +
	"data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

// A closed union that REPLACES a row's gap and padding rather than appending
// to them, so exactly one of each group is ever emitted.
//
// `touch` exists for exactly one call site: the composer's attach menu, whose
// rows are thumb targets on a phone and were ~40% taller than a pointer menu's
// before the migration. Shrinking a touch target is a product decision, not a
// side effect of moving onto the shared primitive, so it stays a member here
// and conduit-test-de3.6 owns whether the two looks should converge.
export const MENU_ITEM_DENSITY_CLASSES = {
	default: `gap-2 ${FLOATING_ITEM_PADDING_CLASSES}`,
	touch: "gap-2.5 px-4 py-3",
} as const;

export type MenuItemDensity = keyof typeof MENU_ITEM_DENSITY_CLASSES;

export const FLOATING_ITEM_CLASSES = `${FLOATING_ITEM_BASE_CLASSES} ${MENU_ITEM_DENSITY_CLASSES.default}`;

export const FLOATING_POSITIONING_DEFAULTS = {
	align: "start",
	collisionPadding: 8,
	preventScroll: false,
	sideOffset: 4,
	strategy: "fixed",
} as const;
