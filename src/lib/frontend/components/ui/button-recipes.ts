/**
 * Button's colour vocabulary: the variant recipes, and the two closed unions a
 * call site may pick from.
 *
 * A plain module rather than Button.svelte's `<script module>` for one blunt
 * reason: the repo's non-frontend tsconfig resolves `*.svelte` through an
 * ambient shim that exposes only the default export, so nothing under `test/`
 * can see a named export from a component. The unit test that sweeps every
 * variant x tone x hoverFill combination has to enumerate the real maps or it
 * silently stops covering whatever was added last. Keeping the vocabulary here
 * is what makes that test exhaustive by construction.
 *
 * Named exports from `components/ui/` are off-limits to FEATURE components
 * (`private-recipe-import`, ADR-0003). This is for the primitive, its stories
 * and its tests; a feature picks a tone through Button's props.
 */

export type ButtonVariant =
	| "primary"
	| "inverse"
	| "secondary"
	| "task-stop-all"
	| "ghost"
	| "ghost-accent"
	| "danger"
	| "danger-soft"
	| "success-soft"
	| "danger-outline"
	| "accent-soft"
	| "toolbar"
	| "pill"
	| "filter"
	| "field"
	| "composer-model"
	| "composer-checkout"
	| "composer-word"
	| "composer-row"
	| "picker-row"
	| "composer-summary"
	| "ask"
	| "goal"
	| "capsule-primary"
	| "chip"
	| "menu-trigger"
	| "scrim"
	| "sheet-scrim"
	| "scrim-clear";

/**
 * Resting text colour paired with its hover step, as ONE decision. "Dim,
 * brightening to full" is a single affordance; splitting it across two
 * props would let a call site assemble a pairing nobody designed.
 *
 * This is a PUBLIC closed union, and a `tone` prop REPLACES the variant's
 * own rather than adding to it. That distinction is the whole ticket. A
 * consumer `class` can only ever append, and two `text-*` utilities in one
 * class list collide on STYLESHEET order, not class order -- so which
 * colour you actually got depended on a byte offset in the built CSS that
 * nobody could see from the call site. Replacing means exactly one
 * `text-*` is ever emitted, so there is no collision and no order to know.
 * The same argument that produced `align`, applied to
 * the group that 39 of the remaining native controls actually care about.
 *
 * Members earn their place by cross-file evidence, the same bar the
 * variants are held to. `warning` and the filled variants' `text-bg` are
 * deliberately NOT here: `text-bg` is only legible against an accent or
 * error fill, so offering it as a free-standing choice invites an
 * invisible label. Those stay inline in VARIANT_RECIPES, private.
 */
export const TONE_CLASSES = {
	/** Emits nothing; the label inherits whatever colour surrounds it. */
	inherit: "",
	/** Body text, with no hover step. */
	default: "text-text",
	secondary: "text-text-secondary hover:text-text",
	muted: "text-text-muted hover:text-text",
	/**
	 * `pill`'s pairing. It used to brighten one step short of full, but the
	 * Final palette folds secondary onto muted, so the one step up IS full.
	 */
	"muted-soft": "text-text-muted hover:text-text",
	dimmer: "text-text-dimmer hover:text-text",
	accent: "text-accent",
	error: "text-error",
	success: "text-success",
	goal: "text-status-goal",
	"goal-paused": "text-status-amber",
	"goal-met": "text-status-green",
} as const;

/**
 * The hover background wash, on the same replace-not-append contract as
 * `tone`. Only the NEUTRAL washes are public: these are the ones a call
 * site genuinely chooses between, and every member below is worn by at
 * least three hand-written controls today. The accent/error/success fills
 * belong to their variants and stay private, because "danger, but with a
 * sidebar hover" is not a thing anyone should be able to ask for.
 *
 * `overlay` and `overlay-soft` keep their 0.04 and 0.03 neutral washes.
 * `alt` is the tinted fill (the Final bubble step) and `surface` the card
 * fill. They differ in both themes, so neither may fold onto the other.
 */
export const HOVER_FILL_CLASSES = {
	none: "",
	/** Theme-flipping neutral scrim in the token language. */
	text: "hover:bg-text/5",
	overlay: "hover:bg-[rgba(var(--overlay-rgb),0.04)]",
	"overlay-soft": "hover:bg-[rgba(var(--overlay-rgb),0.03)]",
	alt: "hover:bg-bg-alt",
	surface: "hover:bg-bg-surface",
	sidebar: "hover:bg-sidebar-hover",
	base: "hover:bg-bg",
	"success-faint": "hover:bg-success/[0.06]",
	/**
	 * The accent tint, for a control whose LABEL is already accent-coloured, so
	 * a neutral wash would read as the label dimming rather than the row
	 * lighting up. TerminalPanel's "+ Terminal" is the first; FileMenu and
	 * CommandMenu use the same pair for their active row.
	 */
	"accent-bg": "hover:bg-accent-bg",
} as const;

export type ButtonTone = keyof typeof TONE_CLASSES;
export type ButtonHoverFill = keyof typeof HOVER_FILL_CLASSES;

/**
 * How a button looks when it is off.
 *
 * This lived in BASE_CLASSES, which is reserved for things that are genuinely
 * invariant, and it was not one: nine hand-written controls dissented, and a
 * consumer class cannot beat a BASE utility in the same group, so each of them
 * was blocked from migrating onto Button by exactly that one string
 *.
 *
 * Both `disabled:` and `aria-disabled:` are emitted for every member because
 * Button sets `aria-disabled` for the `loading` and "explain why" cases, where
 * a real `disabled` attribute would suppress the hover that carries the
 * explanation.
 *
 * The cursor tracks the member rather than being a second axis: nobody in the
 * codebase mixes them independently, and a second prop here would double the
 * surface for no evidenced gain.
 *
 * `undimmed` is not called `none` on purpose. Elsewhere in this file `none`
 * means "emits nothing, the group is yours"; this member emits `opacity-100`,
 * which is an active refusal to dim (ToolSubagentCard's as-found behaviour),
 * not an absence.
 */
export const DISABLED_CLASSES = {
	/** Today's universal default. */
	dim:
		"disabled:opacity-50 disabled:cursor-not-allowed " +
		"aria-disabled:opacity-50 aria-disabled:cursor-not-allowed",
	/** chat/FileViewer, terminal/TerminalPanel. */
	faint:
		"disabled:opacity-30 disabled:cursor-default " +
		"aria-disabled:opacity-30 aria-disabled:cursor-default",
	/** input/InputArea's send button. */
	ghosted:
		"disabled:opacity-25 disabled:cursor-default " +
		"aria-disabled:opacity-25 aria-disabled:cursor-default",
	/** chat/ToolSubagentCard: stays fully lit, only the cursor changes. */
	undimmed:
		"disabled:opacity-100 disabled:cursor-default " +
		"aria-disabled:opacity-100 aria-disabled:cursor-default",
	/**
	 * Emits nothing, so a call site that already spells its own dead state out
	 * in plain (unprefixed) classes keeps it. chat/QuestionCard's "Submitting…"
	 * button is the case: it is `disabled` and carries `opacity-60
	 * cursor-not-allowed` unconditionally, and a `disabled:`-prefixed utility
	 * is emitted after an unprefixed one, so ANY other member here would win
	 * the fight and restyle it.
	 */
	none: "",
} as const;

export type ButtonDisabledStyle = keyof typeof DISABLED_CLASSES;

/**
 * A variant is three separable slots, not one string, so that `tone` and
 * `hoverFill` have something to replace. The split is exact: concatenating
 * a recipe's three fields reproduces the single string this map used to
 * hold, token for token, which is what makes the restructure zero-diff by
 * construction rather than by inspection. Button.stories.ts asserts it.
 *
 * `chrome` is everything that is neither the label colour nor the hover
 * wash: borders, the RESTING background, and (for the pills) geometry. It
 * is a raw string because it is the variant's own business and nothing
 * replaces it.
 *
 * `text-bg`, not `text-white`, on the two filled variants. In the dark
 * theme (the default) the accent and error fills are both light pinks, so
 * a white label on either measures 2.56:1 -- under AA's 3:1 large-text
 * floor, on the app's most prominent call to action. `text-bg` measures
 * 6.93:1 dark and 5.60:1 light, so it passes in BOTH themes where white
 * passes in only one.
 *
 * The three transparent-base hover washes sit at 5%, not 10%. Five call
 * sites across three files had each dialled the 10% down by hand -- to 5%,
 * 6% or 0% -- and not one had dialled it up. When every
 * consumer corrects a default in the same direction the default is wrong.
 */
type VariantRecipe = {
	chrome: string;
	tone: string;
	hoverFill: string;
};

export const VARIANT_RECIPES: Record<ButtonVariant, VariantRecipe> = {
	"capsule-primary": {
		chrome: "bg-accent-bg",
		tone: "text-accent",
		hoverFill: "hover:bg-accent-bg",
	},
	chip: {
		chrome: "bg-chip",
		tone: TONE_CLASSES.secondary,
		hoverFill: HOVER_FILL_CLASSES.text,
	},
	"menu-trigger": {
		chrome: "data-[state=open]:bg-accent-bg data-[state=open]:text-accent",
		tone: TONE_CLASSES.secondary,
		hoverFill: HOVER_FILL_CLASSES.text,
	},
	scrim: {
		chrome: "bg-[rgba(var(--overlay-rgb),0.35)]",
		tone: TONE_CLASSES.default,
		hoverFill: "",
	},
	"sheet-scrim": {
		chrome: "bg-backdrop",
		tone: TONE_CLASSES.default,
		hoverFill: "",
	},
	"scrim-clear": {
		chrome: "",
		tone: TONE_CLASSES.default,
		hoverFill: "",
	},
	"composer-summary": {
		// Keyboard focus rings the summary words, not the full-width tap target.
		chrome:
			"group/composer-summary min-w-0 w-full gap-[5px] font-sans text-[12px] font-normal [&:focus-visible]:ring-0",
		tone: "text-text-muted",
		hoverFill: "hover:text-text",
	},
	"composer-row": {
		chrome:
			"min-h-[50px] w-full gap-[10px] rounded-[10px] px-[10px] text-left text-[13px] font-normal font-sans",
		tone: "text-text",
		hoverFill: "hover:bg-hover",
	},
	"picker-row": {
		chrome:
			"flex min-h-[36px] max-md:min-h-[50px] w-full min-w-0 items-center gap-[10px] rounded-[10px] px-[10px] py-[6px] text-left text-[13.5px] font-normal font-sans focus-visible:ring-inset aria-current:bg-accent/14 aria-pressed:bg-accent/14",
		tone: "text-text",
		hoverFill: "hover:bg-hover",
	},
	ask: {
		chrome: "bg-status-ask/22",
		tone: "text-status-ask",
		hoverFill: "hover:bg-status-ask/30",
	},
	"composer-model": {
		chrome: "min-w-0 gap-[6px] font-sans text-[13px] font-normal",
		tone: "text-text-secondary",
		hoverFill: "hover:bg-hover",
	},
	"composer-checkout": {
		chrome: "min-w-0 bg-chip font-mono text-[11.5px] font-normal",
		tone: "text-text-secondary",
		hoverFill: "hover:bg-hover",
	},
	"composer-word": {
		// An offset outline, so focus clears the glyphs and the dotted underline.
		chrome:
			"min-w-0 gap-[5px] rounded-[4px] font-sans text-[12px] font-normal underline decoration-dotted decoration-border-chip underline-offset-[4px] [&:focus-visible]:ring-0 [&:focus-visible]:outline-2 [&:focus-visible]:outline-solid [&:focus-visible]:outline-offset-[3px] [&:focus-visible]:outline-text",
		tone: "text-text-muted",
		hoverFill: "hover:text-text",
	},
	goal: {
		chrome: "bg-status-goal",
		tone: "text-bg",
		hoverFill: "hover:bg-status-goal/90",
	},
	primary: {
		chrome: "bg-accent",
		tone: "text-bg",
		hoverFill: "hover:bg-accent-hover",
	},
	/**
	 * A neutral filled call to action, for a surface where the accent would
	 * shout: a toast's primary action. It wears the inverse pair, the tokens
	 * the theme reserves for deliberately inverted surfaces, so it reads as
	 * "the one to press" in both themes without borrowing a status colour.
	 */
	inverse: {
		chrome: "bg-inverse-bg",
		tone: "text-inverse-text",
		hoverFill: "hover:bg-inverse-bg/85",
	},
	/**
	 * The mockup's `.btn`: a raised fill that brightens its border and label
	 * on hover rather than washing, so it reads the same on any surface.
	 */
	secondary: {
		chrome: "border border-border bg-bg-alt",
		tone: TONE_CLASSES.secondary,
		hoverFill: "hover:border-text-muted",
	},
	"task-stop-all": {
		chrome:
			"border border-border bg-bg-alt gap-1.5 rounded-[9px] px-[10px] py-[6px] text-[11.5px]",
		tone: "text-status-red",
		hoverFill: "hover:border-text-muted",
	},
	ghost: {
		chrome: "",
		tone: TONE_CLASSES.secondary,
		hoverFill: HOVER_FILL_CLASSES.text,
	},
	/** A toggle chip; pressed takes the ask tint, as the Final sidebar draws it. */
	filter: {
		chrome:
			"h-[24px] gap-[5px] rounded-full bg-chip px-[8px] text-[12px] font-medium aria-pressed:bg-status-ask/18 aria-pressed:text-status-ask",
		tone: TONE_CLASSES.secondary,
		hoverFill: "hover:bg-hover",
	},
	/** A menu trigger dressed as a field: SearchInput's height, fill and radius. */
	field: {
		chrome:
			"h-[30px] gap-[3px] rounded-[9px] bg-chip pl-[10px] pr-[7px] text-[12.5px] font-medium",
		tone: TONE_CLASSES.secondary,
		hoverFill: "hover:bg-hover",
	},
	"ghost-accent": {
		chrome: "",
		tone: TONE_CLASSES.accent,
		hoverFill: "hover:bg-accent/5",
	},
	danger: {
		chrome: "bg-error",
		tone: "text-bg",
		hoverFill: "hover:bg-error/90",
	},
	"danger-soft": {
		// /12, not /22: the lightest tint that keeps the error label at 4.5:1 on a
		// dark popover and in the light theme (theme-contrast.test.ts).
		chrome: "bg-error/12",
		tone: "text-error",
		hoverFill: "hover:bg-error/20",
	},
	// The three below are the approve / deny / tool-action language already
	// duplicated across QuestionCard, PermissionCard, ToolGenericCard and
	// ToolGroupItem. Added on cross-file evidence only.
	"success-soft": {
		chrome: "border border-success/20 bg-success/10",
		tone: TONE_CLASSES.success,
		hoverFill: "hover:bg-success/15",
	},
	"danger-outline": {
		chrome: "border border-border bg-transparent",
		tone: TONE_CLASSES.error,
		hoverFill: "hover:bg-error/[0.08]",
	},
	"accent-soft": {
		chrome: "bg-accent/10",
		tone: TONE_CLASSES.accent,
		hoverFill: "hover:bg-accent/20",
	},
	/**
	 * The badge-shaped trigger of a dropdown that reports a current value:
	 * thinking level, context window, active instance. Three of them sit
	 * within ~200px of each other in the header strip.
	 *
	 * This is the one variant that carries GEOMETRY as well as colour, and
	 * the exception is deliberate. `toolbar` is colour-only because its two
	 * consumers genuinely use different boxes (Header 23px with a border,
	 * SessionList an 18px square), so forcing one on both would be a taste
	 * call. The opposite is true here: ModelVariant and
	 * ContextWindowSelector had hand-written BYTE-IDENTICAL 17-utility
	 * copies of this recipe, and being a pill is what the affordance IS.
	 * Splitting it across a variant and a size would mean every call site
	 * has to remember to pair them, and a half-applied pill is worse than
	 * no pill at all.
	 *
	 * Pair with `size="content"`; `sm`/`md` would add a conflicting
	 * radius.
	 */
	pill: {
		chrome:
			"gap-1 h-6 px-2 rounded-full text-xs font-medium font-sans " +
			"border border-border bg-bg-alt duration-100",
		tone: TONE_CLASSES["muted-soft"],
		hoverFill: HOVER_FILL_CLASSES.base,
	},
	/**
	 * Dim icon affordances in a dense toolbar. The 4% overlay fill is the
	 * distinctive part and appears in no other variant.
	 *
	 * Header's `.header-icon-btn` was why the note above said single-file
	 * recipes stay local. It was never single-file: SessionList had
	 * independently hand-written four near-identical copies, agreeing on the
	 * base colour and the hover fill and disagreeing only on the hover text
	 * step. Ten instances across two files.
	 *
	 * Deliberately colour-only. The two toolbars use different geometry --
	 * Header a 23px box with a border, SessionList an 18px square -- so the
	 * box comes from the call site via `size="content"`. Forcing one size on
	 * both would be a taste call smuggled in as a refactor.
	 *
	 * `data-active` rather than an additive `text-accent` at the call site:
	 * consumer `class` is additive and cannot reliably beat a variant
	 * utility, so a toggle that lights up when on needs the variant to own
	 * both states. Pass `data-active=""` when lit, `undefined` when not.
	 *
	 * `data-[active]:text-accent` lives in `chrome`, not `tone`: a
	 * variant-prefixed utility does not compete with an unprefixed one in
	 * the same group, so it survives a `tone` override rather than being
	 * replaced by it. A toolbar toggle keeps lighting up whatever resting
	 * colour the call site picked.
	 */
	toolbar: {
		chrome: "data-[active]:text-accent",
		tone: TONE_CLASSES.dimmer,
		hoverFill: HOVER_FILL_CLASSES.overlay,
	},
};

/**
 * `content` is an opt-out, not a third size: it emits no padding, radius,
 * weight or type scale, so the call site supplies its own ADDITIVELY via
 * `class`. It exists because the component audit found 64 of 81 migration
 * candidates need intrinsic height — `sm`/`md` hard-code a height (`md`'s
 * `h-9`, or text `sm`'s 25px floor), and a call site cannot reliably override
 * that (see component-conventions.mdx: consumer `class` is additive; beating
 * a size utility needs `!`, and a `min-h` floor survives even `h-auto!`).
 * Without this, migrating the codebase onto Button means 64 `!` overrides.
 *
 * `segment` is one cell of a bordered segmented group (the session header's
 * skills | checkout | Settle): square corners, because the group owns the
 * border and radius.
 */
export type ButtonSize =
	| "sm"
	| "md"
	| "capsule-segment"
	| "phone-capsule-segment"
	| "touch-icon"
	| "touch-pill"
	| "navigation-pill"
	| "phone-navigation"
	| "phone-header-icon"
	| "phone-title-menu"
	| "phone-status"
	| "phone-task"
	| "subtitle"
	| "phone-subtitle"
	| "card-action"
	| "phone-card-action"
	| "command-chip"
	| "text-action"
	| "row-action"
	| "transcript"
	| "content"
	| "composer-icon"
	| "composer-action"
	| "composer-chip";

/** Shared by disclosure and navigation rows in the transcript's step log. */
export const TRANSCRIPT_ROW_CLASSES =
	"flex items-center gap-[8px] w-full min-w-0 min-h-[44px] md:min-h-[28px] py-[3px] px-0 text-[13px] text-left";

export type ButtonAlign = keyof typeof ALIGN_CLASSES;

// `focus-visible:outline-hidden` (not `outline-none`) keeps a transparent
// outline that forced-colors mode renders visibly, so the focus indicator
// survives when the box-shadow ring is stripped.
//
// `rounded-lg` and `font-medium` live in the size map rather than here: two
// utilities setting the same property collide on stylesheet order, not class
// order, so a size (or a consumer) could not override a base radius without
// `!`. Anything in BASE is therefore genuinely invariant.
//
// `justify-*` is not here either, for the same reason, but it could not just
// move to the size map: unlike radius, a `content`-sized button still needs
// SOME alignment, and every fixed-size icon box in the app was relying on
// the base one. It became `align` instead — see ALIGN_CLASSES below.
//
// The disabled appearance left for the same reason and by the same route:
// nine controls dissented on how far a dead button should dim, and none of
// them could win against a BASE utility. It is now `disabledStyle` — see
// DISABLED_CLASSES in button-recipes.ts.
const TOUCH_TARGET_CLASSES =
	"relative before:absolute before:content-[''] before:left-1/2 before:top-1/2 before:-translate-x-1/2 before:-translate-y-1/2 before:size-full before:min-h-[44px] before:min-w-[44px]";

const BASE_CLASSES =
	"no-underline cursor-pointer transition-colors " +
	// Neutral, not accent. An accent ring against an accent-filled button
	// (`primary`) is the same colour as the button, so the old
	// `ring-accent/70` was invisible on the one variant that most needed it.
	// `ring-text` contrasts with every surface in both themes. Keyboard only:
	// `focus-visible` never fires on a mouse click.
	"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text";

const SHARED_SIZE_CLASSES = "rounded-lg font-medium";

const SIZE_CLASSES: Record<
	Exclude<ButtonSize, "sm" | "md" | "composer-action">,
	string
> = {
	"text-action": "font-medium",
	"touch-icon": "min-h-[44px] min-w-[44px] rounded-lg",
	"touch-pill": "min-h-[44px] min-w-[44px] rounded-full",
	"navigation-pill":
		"min-h-[44px] gap-1.5 pl-1 pr-2 rounded-full text-[13px] font-medium",
	"phone-navigation":
		"h-[28px] min-w-[44px] gap-[4px] pl-[4px] pr-[9px] rounded-full text-[13px] font-medium",
	"phone-header-icon": "size-[30px] rounded-full",
	"phone-title-menu": "h-[24px] w-[20px] rounded-lg focus-visible:ring-inset",
	"phone-status": "h-[22px] min-w-[44px] rounded-full focus-visible:ring-inset",
	"phone-task":
		"h-[30px] min-w-[44px] gap-[8px] rounded-full focus-visible:ring-inset",
	subtitle: "gap-1.5 text-[11px] leading-[1.35]",
	"phone-subtitle":
		"h-[21px] min-w-[44px] gap-[5px] text-[12.5px] leading-[1.5] focus-visible:ring-inset",
	"card-action": "gap-[6px] rounded-[9px] px-[10px] py-[6px] text-[11.5px]",
	"phone-card-action":
		"h-[28px] min-w-[44px] gap-[6px] rounded-full px-[12px] text-[13px]",
	"command-chip": "h-[24px] rounded-full px-[8px] font-mono text-[11.5px]",
	"capsule-segment":
		"h-[24px] gap-[5px] rounded-full px-[10px] text-[12.5px] font-medium tabular-nums",
	"phone-capsule-segment":
		"h-[24px] min-w-[44px] gap-[5px] rounded-full px-[10px] text-[13px] font-medium tabular-nums focus-visible:ring-inset",
	"composer-icon": "size-[30px] shrink-0 rounded-full",
	"composer-chip": "h-[30px] gap-[5px] rounded-full px-[9px]",
	// Literally no classes, by design — see the ButtonSize doc comment. Not
	// even `h-auto`: that is a button's default height anyway, so emitting it
	// buys nothing and costs a `!` at every call site that wants an explicit
	// height (RewindBanner's `w-6 h-6` exit control, for one), which is the
	// exact tax this size exists to avoid.
	content: "",
	"row-action": "size-[21px] rounded-[6px]",
	transcript: TRANSCRIPT_ROW_CLASSES,
};

/**
 * Main-axis alignment, as a prop rather than a base class, because the base
 * class was a coin flip nobody could see.
 *
 * BASE_CLASSES used to hard-code `justify-center`, so a call site wanting
 * something else had to append a competing utility and hope. Whether it won
 * depended on Tailwind's emission order, which is not alphabetical across
 * groups: `justify-start` is emitted AFTER `justify-center` and wins,
 * `justify-between` is emitted BEFORE it and silently loses. Identical-
 * looking call sites, opposite outcomes, and the only way to tell was to
 * probe byte offsets in the built stylesheet.
 *
 * Exactly one of these is ever emitted, so there is no collision to resolve
 * and no order to know. `center` is the default, which is what BASE already
 * did, so every existing call site is unchanged to the pixel.
 *
 * This matters well beyond tidiness: an audit of the 79 native controls
 * still outside the design system found 34 of them are `w-full text-left`
 * rows. No Button VARIANT could ever have reached them — a variant appends,
 * and BASE had already emitted the conflict — so the largest single group in
 * the migration backlog was unreachable until this moved.
 */
/**
 * The box itself: display, cross-axis alignment, wrapping and selectability.
 * These four travelled together in BASE_CLASSES, and together they are the
 * reason a whole category of control could not migrate at all.
 *
 * A consumer cannot out-rank any of them. Measured in the built stylesheet:
 * `.hidden` at 22357 loses to `.inline-flex` at 22436, so a
 * `class:hidden` toggle silently stops working; `.items-baseline` at 29708
 * loses to `.items-center` at 29745. And `whitespace-nowrap` plus
 * `select-none` quietly redefine any button whose content is prose rather
 * than a label — a URL that should ellipsize, a path that should break, a
 * sentence the user should be able to copy.
 *
 * `flow` emits NOTHING, which hands the box back to the call site: a
 * `<button>` is `inline-block` by default, wraps, and is selectable, so
 * "emits nothing" is exactly the as-found behaviour of every control that
 * needs this. It is the same opt-out shape as `size="content"` and
 * `chrome="bare"` on the field primitives.
 *
 * `ALIGN_CLASSES` is suppressed under `flow` on purpose: `justify-content`
 * does nothing outside a flex or grid container, so emitting it would be
 * the dead-token theatre this epic keeps deleting. Under `flow` the call
 * site owns the box, alignment included.
 */
const LAYOUT_CLASSES = {
	center: "inline-flex items-center whitespace-nowrap select-none",
	// A <button> sizes to its content even as a flex box, so cap it at its
	// container or a nowrap label pushes it over its neighbours.
	block: "flex max-w-full items-center whitespace-nowrap select-none",
	baseline: "inline-flex items-baseline whitespace-nowrap select-none",
	flow: "",
} as const;

export type ButtonLayout = keyof typeof LAYOUT_CLASSES;

const ALIGN_CLASSES = {
	center: "justify-center",
	start: "justify-start",
	between: "justify-between",
} as const;

/**
 * Button's class string for its resolved props. Button owns the prop defaults,
 * so every recipe axis is required here and the two can never disagree.
 */
export function buttonClasses({
	variant,
	tone,
	hoverFill,
	disabledStyle,
	layout,
	align,
	size,
	iconOnly,
	touchTarget,
	inert,
	className,
}: Readonly<{
	variant: ButtonVariant;
	tone?: ButtonTone | undefined;
	hoverFill?: ButtonHoverFill | undefined;
	disabledStyle: ButtonDisabledStyle;
	layout: ButtonLayout;
	align: ButtonAlign;
	size: ButtonSize;
	iconOnly: boolean;
	touchTarget: boolean | "always";
	inert: boolean;
	className?: string | undefined;
}>): string {
	const sizeClasses =
		size === "composer-action"
			? `h-[34px] shrink-0 rounded-full gap-[6px] text-[13px] font-semibold ${iconOnly ? "w-[34px]" : "px-[12px]"}`
			: size !== "sm" && size !== "md"
				? SIZE_CLASSES[size]
				: iconOnly
					? `${size === "sm" ? "h-8 w-8" : "h-9 w-9"} ${SHARED_SIZE_CLASSES}`
					: size === "sm"
						? // Literal px from the mockup's `.btn`. `min-h`, not `h`, so a
							// taller touch target composes without a collision.
							"min-h-[25px] px-[10px] py-[4px] text-[11.5px] gap-[5px] rounded-[7px] font-normal"
						: `h-9 px-4 text-sm gap-2 ${SHARED_SIZE_CLASSES}`;

	/**
	 * Nearly every variant declares a `hover:bg-*`, and `:hover` keeps matching while a
	 * button is disabled, so without a disabled hover guard a dead button still lit up
	 * under the cursor -- in every variant, everywhere in the app. It read as
	 * interactive at the exact moment it is not.
	 *
	 * Dropped in JS rather than fixed in CSS because the primitive already knows.
	 * The two CSS routes both cost something: `disabled:pointer-events-none`
	 * takes `cursor-not-allowed` with it (no pointer events, no cursor style),
	 * and chaining `not-disabled:not-aria-disabled:hover:` across eleven variants
	 * writes the inert condition a second time, in a second language, where it
	 * can drift from the one `handleClick` already guards on. This reuses that
	 * single flag.
	 *
	 * The recipe strings above stay literal, so Tailwind's scanner still emits
	 * every hover class it always did; only whether they are APPLIED is dynamic.
	 * That holds for the `tone` / `hoverFill` unions too -- the utilities live
	 * as literals in TONE_CLASSES and HOVER_FILL_CLASSES, which the scanner
	 * reads, so a wash keeps being emitted after the last hand-written call
	 * site that spelled it out is migrated away.
	 *
	 * Scope is the variant. A consumer `class` that brings its own `hover:` is
	 * left alone -- it is the call site's string, and silently editing a
	 * prop we were handed is a worse surprise than the one being fixed.
	 */
	const recipe = VARIANT_RECIPES[variant];
	const assembled = [
		recipe.chrome,
		tone === undefined ? recipe.tone : TONE_CLASSES[tone],
		hoverFill === undefined ? recipe.hoverFill : HOVER_FILL_CLASSES[hoverFill],
	]
		.filter(Boolean)
		.join(" ");
	const variantClass = inert
		? assembled
				.split(" ")
				.filter((cls) => !cls.startsWith("hover:"))
				.join(" ")
		: assembled;

	return [
		BASE_CLASSES,
		LAYOUT_CLASSES[layout],
		DISABLED_CLASSES[disabledStyle],
		layout === "flow" ? "" : ALIGN_CLASSES[align],
		variantClass,
		sizeClasses,
		touchTarget ? TOUCH_TARGET_CLASSES : "",
		touchTarget === true ? "md:before:hidden" : "",
		className,
	]
		.filter(Boolean)
		.join(" ");
}

/**
 * Exported so tests and story controls enumerate the real thing rather than
 * a hand-copied list that silently goes stale the moment a member is added.
 * `VARIANT_RECIPES` is a `Record<ButtonVariant, ...>`, so its keys are
 * exhaustive by the type checker, not by anyone remembering.
 */
export const BUTTON_VARIANTS = Object.keys(VARIANT_RECIPES) as ButtonVariant[];
export const BUTTON_TONES = Object.keys(TONE_CLASSES) as ButtonTone[];
export const BUTTON_HOVER_FILLS = Object.keys(
	HOVER_FILL_CLASSES,
) as ButtonHoverFill[];
export const BUTTON_DISABLED_STYLES = Object.keys(
	DISABLED_CLASSES,
) as ButtonDisabledStyle[];
