<!--
  Tabs — a strip of options where picking one swaps the panel below it.

  Two files hand-wrote a tab strip and neither had any of the keyboard or
  screen-reader contract a tab strip owes: no `role="tablist"`, no
  `role="tab"`, no `aria-selected`, no roving tabindex, no arrow keys. Five
  settings tabs and a Unified/Split switch were, to assistive tech, six
  unrelated buttons (conduit-test-mkah).

  Built on bits-ui's Tabs rather than hand-rolled, for the same reason ui/Menu
  is built on its DropdownMenu: roving focus, arrow/Home/End handling and the
  role wiring are the hard, easy-to-get-subtly-wrong part, and they are not
  what this codebase should be spending its judgement on.

  ## Why this is not the same component as ui/SegmentedControl

  They look identical and share segmented-styles.ts, but they mean different
  things and owe different contracts. Tabs answer "which panel am I looking
  at"; a SegmentedControl answers "what value is set", which is a form input.
  A `semantics` prop on one component would hide that choice behind an enum,
  and the wrong value produces markup that lies to a screen reader while
  looking perfect. Two names make the caller pick on purpose.

  ## `aria-controls` is deliberately absent

  bits only wires it when you also use its `Tabs.Content`, and both consumers
  render their panels inside `{#if}` blocks, so every id would dangle whenever
  its tab was not the active one. `aria-selected` plus `role="tab"` is what
  actually carries the state. Same call ui/Disclosure made, for the same
  reason.
-->
<script lang="ts" generics="T extends string">
	import { Tabs } from "bits-ui";
	import {
		SEGMENTED_VARIANTS,
		segmentedItemClass,
		type SegmentedOption,
		type SegmentedVariant,
	} from "./segmented-styles.js";

	let {
		value = $bindable(),
		options,
		variant = "underline",
		label,
		class: className,
	}: {
		/** The selected tab's value. */
		value: T;
		options: readonly SegmentedOption<T>[];
		variant?: SegmentedVariant;
		/** Names the strip for screen readers, e.g. "Settings sections". */
		label: string;
		/** Additional classes for the strip element. */
		class?: string;
	} = $props();

	const recipe = $derived(SEGMENTED_VARIANTS[variant]);
</script>

<!--
  bits' Root is a plain wrapper div with no styling of its own; the strip
  classes go on the List, which is the element that was there before.
-->
<Tabs.Root
	{value}
	onValueChange={(next) => {
		value = next as T;
	}}
>
	<Tabs.List
		aria-label={label}
		class={[recipe.list, className].filter(Boolean).join(" ")}
	>
		{#each options as option (option.value)}
			<Tabs.Trigger
				value={option.value}
				disabled={option.disabled}
				data-testid={option.testId}
				class={segmentedItemClass(variant, value === option.value)}
			>
				{option.label}
			</Tabs.Trigger>
		{/each}
	</Tabs.List>
</Tabs.Root>
