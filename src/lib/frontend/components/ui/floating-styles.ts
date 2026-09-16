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
export const FLOATING_SURFACE_CLASSES =
	"rounded-lg border border-border bg-bg-alt py-1 " +
	"focus-visible:outline-hidden " +
	"data-[side=top]:shadow-menu data-[side=bottom]:shadow-dropdown " +
	"data-[side=left]:shadow-panel data-[side=right]:shadow-panel " +
	"z-[var(--z-popover)]";

export const FLOATING_MENU_CONTENT_CLASSES = `${FLOATING_SURFACE_CLASSES} max-h-[var(--bits-dropdown-menu-content-available-height)] overflow-y-auto`;

export const FLOATING_TOOLTIP_CLASSES = `${FLOATING_SURFACE_CLASSES} max-w-xs px-2 text-xs text-text`;

export const FLOATING_ITEM_PADDING_CLASSES = "px-3 py-1.5";

export const MENU_ITEM_VARIANT_CLASSES = {
	default: "text-text",
	danger: "text-error",
} as const;

export const MENU_RADIO_ITEM_COLOR_CLASSES =
	"data-[state=unchecked]:text-text data-[state=checked]:text-accent";

export const FLOATING_ITEM_CLASSES =
	`flex cursor-default select-none items-center gap-2 ${FLOATING_ITEM_PADDING_CLASSES} text-sm ` +
	"hover:bg-bg focus:bg-bg focus:outline-hidden " +
	"data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

export const FLOATING_POSITIONING_DEFAULTS = {
	align: "start",
	collisionPadding: 8,
	preventScroll: false,
	sideOffset: 4,
	strategy: "fixed",
} as const;
