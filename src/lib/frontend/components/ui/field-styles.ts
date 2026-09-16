export type FieldSize = "sm" | "md";

// focus-visible ring matches Button; text fields also match :focus-visible on click.
// aria-invalid:border-error is the shared error affordance (paired with Field's error text).
export const FIELD_BASE_CLASSES =
	"block w-full rounded-md border border-border bg-input-bg text-text " +
	"placeholder:text-text-muted transition-colors " +
	// Tracks Button deliberately (see the comment above) — a neutral ring, not
	// accent. `border-accent` stays: on a field the accent border is the
	// "this one is live" signal, and the ring is the keyboard-focus signal.
	"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text focus-visible:border-accent " +
	"disabled:opacity-50 disabled:cursor-not-allowed " +
	"aria-invalid:border-error";

// Height-bearing controls (TextInput, Select). Mirror Button's sm/md heights.
export const CONTROL_SIZE_CLASSES: Record<FieldSize, string> = {
	sm: "h-8 px-2.5 text-xs",
	md: "h-9 px-3 text-sm",
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
