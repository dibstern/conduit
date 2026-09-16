<!--
  Disclosure — the expand/collapse header row used by the chat cards.

  Named for the affordance, not the tag. Five chat cards had each hand-written
  the same dim-small-row recipe (conduit-test-de3.35.5), agreeing on the hover
  fill, the transition and the duration, and disagreeing on vertical rhythm.

  This migration is deliberately ZERO-DIFF: every as-found gap/padding pairing
  is preserved through `density`. Two of the three turned out to be intentional
  rather than drift — ToolGroupItem's source labels itself "Compact row", and
  ThinkingBlock's gap-1.5 matches the streaming bar rendered directly above it
  in the same file. Flattening them would have been a taste call dressed up as
  a refactor. Whether the three should converge is tracked separately; until it
  is decided, `density` carries the difference honestly instead of hiding it.

  Deliberately NOT a consumer: ToolSubagentCard. It wears the same recipe but
  navigates to a session rather than expanding anything, so it has no `expanded`
  state and putting it here would make `aria-expanded="false"` a standing lie.
  Shared appearance is not shared semantics.

  The accessibility fix is the point of the ticket, not a side effect: not one
  of the five set `aria-expanded`, so five expand/collapse controls announced
  nothing about their state. The primitive now always sets it, which means the
  fix cannot be forgotten and cannot drift back out.

  `aria-controls` is deliberately OPTIONAL rather than required. All five
  consumers render the expanded region inside `{#if expanded}`, so when the row
  is collapsed there is no element for the id to point at, and a required prop
  would only buy us five dangling references. Pass it when the region is always
  in the DOM; otherwise `aria-expanded` is doing the real work.
-->
<script module lang="ts">
	// Shared with every consumer; the hover/transition/duration triple is the
	// part all five copies already agreed on, so it is genuinely invariant.
	const BASE_CLASSES =
		"flex items-center w-full px-3 text-left border-none bg-transparent " +
		"text-xs text-text-dimmer cursor-pointer " +
		"hover:bg-bg-surface transition-colors duration-150";

	const DENSITY_CLASSES = {
		default: "gap-2.5 py-2",
		compact: "gap-2 py-1",
		tight: "gap-1.5 py-2",
	} as const;
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";

	let {
		expanded,
		onToggle,
		ariaControls = undefined,
		chevron = true,
		selectable = false,
		density = "default",
		class: className,
		children,
	}: {
		/**
		 * Controlled, deliberately not `$bindable`. Every consumer already owns
		 * this state — several derive it from message status rather than storing
		 * it — so a two-way binding would create a second source of truth for
		 * something the card is already the authority on.
		 */
		expanded: boolean;
		onToggle: () => void;
		/** `id` of the region this row expands, when that region is always rendered. */
		ariaControls?: string;
		/** ToolGroupItem opts out: it shows tree connectors (└ ├) instead. */
		chevron?: boolean;
		/** `select-text` instead of `select-none`, for rows whose text is worth copying. */
		selectable?: boolean;
		/**
		 * Vertical rhythm. These are the three as-found pairings, not a scale:
		 *
		 *   default  gap-2.5 py-2   top-level card headers (ToolGroupCard,
		 *                           ToolGenericCard, SkillItem)
		 *   compact  gap-2   py-1   ToolGroupItem, a row nested inside a group
		 *   tight    gap-1.5 py-2   ThinkingBlock's collapsed bar
		 *
		 * `tight` has MORE padding than `compact`; they vary on different axes.
		 */
		density?: "default" | "compact" | "tight";
		class?: string;
		children: Snippet;
	} = $props();

	const rowClass = $derived(
		[
			BASE_CLASSES,
			DENSITY_CLASSES[density],
			selectable ? "select-text" : "select-none",
			className,
		]
			.filter(Boolean)
			.join(" "),
	);
</script>

<button
	class={rowClass}
	aria-expanded={expanded}
	aria-controls={ariaControls}
	onclick={onToggle}
>
	{#if chevron}
		<!-- aria-hidden: the rotation is decorative, `aria-expanded` above is
		     what actually reports the state. -->
		<span
			aria-hidden="true"
			class="text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"
			class:rotate-90={expanded}
		>
			<Icon name="chevron-right" size={14} />
		</span>
	{/if}
	{@render children()}
</button>
