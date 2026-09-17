/**
 * `content` is an opt-out, not a third size, exactly as on ui/Button: it emits
 * no height, padding or type scale, so the call site supplies its own
 * ADDITIVELY through `class`. Without it the three chromeless fields in the app
 * cannot migrate at all — `sm`/`md` hard-code `h-8`/`h-9`, and a consumer class
 * cannot beat a primitive utility in the same group (conduit-test-d1d4).
 */
export type FieldSize = "sm" | "md";
export type FieldControlSize = FieldSize | "content";

/**
 * What every field is regardless of how it is painted. Deliberately short.
 *
 * `block w-full`, the border, the background, the placeholder colour and the
 * focus ring all used to live here and are now in FIELD_CHROME_CLASSES. None of
 * them is invariant: the three chromeless fields disagree with all five, and two
 * utilities from one Tailwind group are resolved by stylesheet order, not class
 * order, so a consumer could never have won. Same failure ui/Button's
 * BASE_CLASSES had, fixed the same way.
 */
export const FIELD_BASE_CLASSES =
	"text-text transition-colors " +
	"disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * How a field is painted, as ONE closed union that REPLACES the lot, on the
 * same contract as ui/Button's `tone`.
 *
 * `bare` is for the fields whose affordance is the bordered ROW around them
 * rather than the field itself: the terminal tab-rename input and the model
 * picker's search box. It emits no chrome at all, which also means no focus
 * indicator — `outline-none` is preserved from both call sites as-found and is
 * a real accessibility defect, filed rather than fixed here because fixing it
 * is a visible design change (conduit-test-de3.35.9.3).
 *
 * `placeholder:text-text-muted` is chrome rather than base because the model
 * picker uses `text-text-dimmer` and would have collided with it.
 *
 * `aria-invalid:border-error` is chrome for a sharper reason: it paints a
 * BORDER, so on a borderless field it is not a subtler affordance, it is no
 * affordance at all. A bare field that needs an error state should use an
 * outline the way CHOICE_BASE_CLASSES does. No consumer needs one today, so
 * this is recorded rather than built.
 */
export const FIELD_CHROME_CLASSES = {
	bordered:
		"block w-full rounded-md border border-border bg-input-bg " +
		"placeholder:text-text-muted " +
		// Tracks Button deliberately — a neutral ring, not accent.
		// `border-accent` stays: on a field the accent border is the "this one
		// is live" signal, and the ring is the keyboard-focus signal.
		"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text " +
		"focus-visible:border-accent " +
		"aria-invalid:border-error",
	bare: "outline-none",
} as const;

export type FieldChrome = keyof typeof FIELD_CHROME_CLASSES;

// Height-bearing controls (TextInput, Select). Mirror Button's sm/md heights.
// `content` emits nothing; see FieldControlSize above.
export const CONTROL_SIZE_CLASSES: Record<FieldControlSize, string> = {
	sm: "h-8 px-2.5 text-xs",
	md: "h-9 px-3 text-sm",
	content: "",
};

// Textarea: no fixed height (rows drives it); vertical padding + text scale only.
export const TEXTAREA_SIZE_CLASSES: Record<FieldSize, string> = {
	sm: "px-2.5 py-1.5 text-xs",
	md: "px-3 py-2 text-sm",
};

// Checkbox/Radio. Deliberately NOT built on FIELD_BASE_CLASSES: that recipe is
// for box-shaped text fields (`block w-full`, a border, a background, a
// placeholder colour), none of which apply to a control the UA paints itself.
// What carries over is the part that is genuinely shared across every field:
// the neutral focus ring and the disabled treatment.
//
// `accent-accent` is the whole visual contract. It was previously hand-written
// per call site and one of them, RewindBanner, wrote `accent-[var(--accent)]`
// against a custom property that is defined nowhere in the codebase -- so three
// radios in a confirmation modal had been rendering the UA default blue rather
// than the brand pink (conduit-test-de3.35.7).
//
// The invalid affordance is an OUTLINE, not `aria-invalid:border-error` like
// FIELD_BASE_CLASSES uses: a UA-painted checkbox ignores `border`, and an
// `aria-invalid` that only assistive tech can perceive is half a fix. Outline
// is the one box-adjacent property a native control honours.
//
// `outline-solid` is not redundant. Tailwind v4's `outline-2` emits
// `outline-style: var(--tw-outline-style)`, and `outline-hidden` on the line
// above sets that variable to `none` -- so without it a checkbox that is both
// focused and invalid silently loses its error outline.
export const CHOICE_BASE_CLASSES =
	"shrink-0 accent-accent cursor-pointer " +
	"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text " +
	"aria-invalid:outline-solid aria-invalid:outline-2 " +
	"aria-invalid:outline-offset-1 aria-invalid:outline-error " +
	"disabled:opacity-50 disabled:cursor-not-allowed";
