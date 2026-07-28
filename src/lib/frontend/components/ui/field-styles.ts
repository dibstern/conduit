export type FieldSize = "sm" | "md";

// focus-visible ring matches Button; text fields also match :focus-visible on click.
// aria-invalid:border-error is the shared error affordance (paired with Field's error text).
export const FIELD_BASE_CLASSES =
	"block w-full rounded-md border border-border bg-input-bg text-text " +
	"placeholder:text-text-muted transition-colors " +
	"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:border-accent " +
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
