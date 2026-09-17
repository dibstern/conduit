<!--
  DetachedListbox — the shared surface for a combobox whose input lives outside
  the list: FileMenu, CommandMenu and DirectoryAutocomplete.

  It owns exactly the invariants those three surfaces must not each re-derive:
  the listbox role, a required id and accessible name, non-focusability, the
  canonical floating surface on the top side, and staying inline.

  It deliberately owns nothing else — no portal, trigger, open state, active
  index, option rendering, filtering, keyboard handling, dismissal or scroll
  API. The caller keeps DOM focus on its own input and drives the list through
  `aria-activedescendant`, so the caller also owns option ids, `role="option"`,
  `aria-selected`, and the input's combobox attributes.

  Not focusable by construction: `aria-activedescendant` navigation means the
  input never loses DOM focus, so a tabbable listbox would be a second, wrong
  tab stop. Never portaled: every consumer scrolls the active row with a
  descendant query against this element.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
	import { DETACHED_LISTBOX_SURFACE_CLASSES } from "./floating-styles.js";

	type DetachedListboxProps = {
		id: string;
		ariaLabel: string;
		class?: string | undefined;
		children: Snippet;
	} & Omit<
		HTMLAttributes<HTMLDivElement>,
		| "aria-label"
		| "children"
		| "class"
		| "id"
		| "role"
		| "tabindex"
		// The caller keeps DOM focus on its own input and drives the list from
		// there, so active-descendant wiring belongs on the INPUT. Accepting it
		// here would let a consumer point the listbox at itself and silently
		// double up the relationship (conduit-test-9kov).
		| "aria-activedescendant"
		| "aria-owns"
	>;

	let {
		id,
		ariaLabel,
		class: className,
		children,
		...rest
	}: DetachedListboxProps = $props();

	// `class` is additive, never an override: a consumer utility that conflicts
	// with a canonical one is resolved by stylesheet order, not by this order.
	// See component-conventions.mdx. The fix for a conflict is a prop that
	// REPLACES the canonical utility (as MenuItem's `density` does) rather than
	// an authoritative (`!`) one that beats it. This surface emits exactly one
	// `rounded-*` and one `z-*`, so neither group is ever contested, and it has
	// no radius prop because there is now only one floating radius in the app.
	const surfaceClass = $derived(
		[DETACHED_LISTBOX_SURFACE_CLASSES, className]
			.filter(Boolean)
			.join(" "),
	);
</script>

<div
	{...rest}
	{id}
	role="listbox"
	aria-label={ariaLabel}
	data-side="top"
	class={surfaceClass}
>
	{@render children()}
</div>
