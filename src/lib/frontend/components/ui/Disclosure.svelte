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
	import { HOVER_FILL_CLASSES } from "./button-recipes.js";

	/**
	 * What every disclosure row is, regardless of where it lives: a full-width
	 * clickable strip whose contents sit on one line, indented to the card
	 * gutter. All nine consumers agree on every token here.
	 *
	 * `border-none` and `bg-transparent` used to be in this list and are gone.
	 * Tailwind v4's preflight already sets `border: 0 solid` and a transparent
	 * background on every `<button>`, so both emitted nothing -- while squatting
	 * on two groups a consumer might legitimately need. `border-none` is the
	 * more dangerous of the pair: it sets border-STYLE to none, so any
	 * `border-b-2` a call site added would render as a 2px-wide nothing. That
	 * exact bug shipped in SettingsPanel's tab strip (conduit-test-mkah).
	 *
	 * `transition-colors duration-150` stays invariant even though the four
	 * SettingsPanel rows had no transition: a 150ms hover fade is invisible to
	 * a screenshot and is the behaviour the other five already chose.
	 */
	const BASE_CLASSES =
		"flex items-center w-full px-3 text-left cursor-pointer " +
		"transition-colors duration-150";

	/**
	 * Type scale, resting colour and hover wash as ONE closed union that
	 * REPLACES the lot, on the same contract as ui/Button's `tone`: a consumer
	 * `class` can only append, and two utilities from one Tailwind group
	 * collide on stylesheet order rather than class order, so an additive
	 * override's outcome depends on a byte offset nobody can see from the call
	 * site. Replacing means exactly one of each is ever emitted.
	 *
	 * These are two real families rather than a scale. `card` is the chat
	 * cards' dim-small row; the other two are SettingsPanel's, which sit on a
	 * bordered panel and so are a step larger and a step brighter.
	 */
	const LOOK_CLASSES = {
		/** The five chat cards (ToolGroupCard, ToolGenericCard, SkillItem, ToolGroupItem, ThinkingBlock). */
		card: `text-xs text-text-dimmer ${HOVER_FILL_CLASSES.surface}`,
		/** SettingsPanel's setup-scenario headers: a titled section you open. */
		section: `text-sm font-medium text-text ${HOVER_FILL_CLASSES["overlay-soft"]}`,
		/** SettingsPanel's instance rows: colour is inherited, because the row's
		 *  own children (name, badges, port) each carry their own. */
		row: `text-sm ${HOVER_FILL_CLASSES["overlay-soft"]}`,
	} as const;

	const DENSITY_CLASSES = {
		default: "gap-2.5 py-2",
		compact: "gap-2 py-1",
		tight: "gap-1.5 py-2",
		roomy: "gap-2 py-2.5",
		/** No gap on purpose: a row that pushes its children apart with
		 *  `justify-between` only gets a minimum-separation fight from one. */
		split: "py-2",
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
		look = "card",
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
		 * Vertical rhythm. These are the as-found pairings, not a scale:
		 *
		 *   default  gap-2.5 py-2   top-level card headers (ToolGroupCard,
		 *                           ToolGenericCard, SkillItem)
		 *   compact  gap-2   py-1   ToolGroupItem, a row nested inside a group
		 *   tight    gap-1.5 py-2   ThinkingBlock's collapsed bar
		 *   roomy    gap-2   py-2.5 SettingsPanel's setup-scenario headers
		 *   split    (none)  py-2   SettingsPanel's instance rows
		 *
		 * `tight` has MORE padding than `compact`; they vary on different axes.
		 */
		density?: keyof typeof DENSITY_CLASSES;
		/**
		 * Type scale + colour + hover wash, REPLACING the default rather than
		 * adding to it. See LOOK_CLASSES above for why that is a replacement.
		 */
		look?: keyof typeof LOOK_CLASSES;
		class?: string;
		children: Snippet;
	} = $props();

	const rowClass = $derived(
		[
			BASE_CLASSES,
			LOOK_CLASSES[look],
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
