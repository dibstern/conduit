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
	| "secondary"
	| "ghost"
	| "ghost-accent"
	| "danger"
	| "success-soft"
	| "danger-outline"
	| "accent-soft"
	| "toolbar"
	| "pill"
	| "pill-warning";

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
 * The same argument that produced `align` (conduit-test-ixfu), applied to
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
	/** Body text, with no hover step. `secondary`'s resting colour. */
	default: "text-text",
	secondary: "text-text-secondary hover:text-text",
	muted: "text-text-muted hover:text-text",
	/** Brightens only one step, not to full. `pill`'s pairing. */
	"muted-soft": "text-text-muted hover:text-text-secondary",
	dimmer: "text-text-dimmer hover:text-text",
	accent: "text-accent",
	error: "text-error",
	success: "text-success",
} as const;

/**
 * The hover background wash, on the same replace-not-append contract as
 * `tone`. Only the NEUTRAL washes are public: these are the ones a call
 * site genuinely chooses between, and every member below is worn by at
 * least three hand-written controls today. The accent/error/success fills
 * belong to their variants and stay private, because "danger, but with a
 * sidebar hover" is not a thing anyone should be able to ask for.
 *
 * Two pairs in here are very probably drift rather than design, and are
 * deliberately NOT collapsed by this ticket:
 *
 *   `overlay` (0.04) vs `overlay-soft` (0.03) -- a 1% alpha delta on a
 *   neutral scrim. Collapsing them is a real, if tiny, pixel change and
 *   so belongs in a ticket that can own the baseline churn.
 *
 *   `alt` vs `surface` -- `--color-bg-alt` and `--color-bg-surface` are
 *   defined to the SAME value in both shipped themes (style.css:29,30 and
 *   :142,143), so these render identically TODAY. Both names survive
 *   anyway: two first-party themes are in flight, and silently rewriting
 *   9 call sites onto a token they did not name would make that
 *   coincidence permanent by accident.
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
 * (conduit-test-8lxm).
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
 * passes in only one (conduit-test-tpdw).
 *
 * The three transparent-base hover washes sit at 5%, not 10%. Five call
 * sites across three files had each dialled the 10% down by hand -- to 5%,
 * 6% or 0% -- and not one had dialled it up (conduit-test-d5nv). When every
 * consumer corrects a default in the same direction the default is wrong.
 */
type VariantRecipe = {
	chrome: string;
	tone: string;
	hoverFill: string;
};

export const VARIANT_RECIPES: Record<ButtonVariant, VariantRecipe> = {
	primary: {
		chrome: "bg-accent",
		tone: "text-bg",
		hoverFill: "hover:bg-accent-hover",
	},
	secondary: {
		chrome: "border border-border",
		tone: TONE_CLASSES.default,
		hoverFill: HOVER_FILL_CLASSES.text,
	},
	ghost: {
		chrome: "",
		tone: TONE_CLASSES.secondary,
		hoverFill: HOVER_FILL_CLASSES.text,
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
	 * no pill at all (conduit-test-de3.35.6).
	 *
	 * Pair with `size="content"`; `sm`/`md` would add a conflicting
	 * `rounded-lg`.
	 */
	pill: {
		chrome:
			"gap-1 h-6 px-2 rounded-full text-xs font-medium font-brand " +
			"border border-border bg-bg-alt duration-100",
		tone: TONE_CLASSES["muted-soft"],
		hoverFill: HOVER_FILL_CLASSES.base,
	},
	/**
	 * `pill`'s elevated state. PermissionModeSelector wears it when the
	 * session is on a permissive approval mode, where the warning colour is
	 * the whole message.
	 *
	 * Deliberately carries no hover step, matching the recipe as found: the
	 * neutral pill's hover says "this opens something", and a warning
	 * surface that lightens under the cursor reads as a warning being
	 * dismissed.
	 *
	 * A second variant string rather than a `warning` boolean on `pill`:
	 * every other colour choice here is a variant, and one boolean modifier
	 * invites the next one.
	 */
	"pill-warning": {
		chrome:
			"gap-1 h-6 px-2 rounded-full text-xs font-medium font-brand " +
			"border border-warning/30 bg-warning-bg duration-100",
		tone: "text-warning",
		hoverFill: HOVER_FILL_CLASSES.none,
	},
	/**
	 * Dim icon affordances in a dense toolbar. The 4% overlay fill is the
	 * distinctive part and appears in no other variant.
	 *
	 * Header's `.header-icon-btn` was why the note above said single-file
	 * recipes stay local. It was never single-file: SessionList had
	 * independently hand-written four near-identical copies, agreeing on the
	 * base colour and the hover fill and disagreeing only on the hover text
	 * step (conduit-test-de3.35.3). Ten instances across two files.
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
