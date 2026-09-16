<!--
  SegmentedControl — a strip of mutually exclusive options that sets a VALUE.

  The form-input sibling of ui/Tabs: same look (both read segmented-styles.ts),
  different meaning. Picking an option here does not swap a panel, it answers a
  question the form is asking. See ui/Tabs.svelte's header for why that is two
  components instead of one with a `semantics` prop.

  Built on bits-ui's RadioGroup, NOT its ToggleGroup, and that choice is the
  whole accessibility story:

  - The hand-written original was `role="group"` + `aria-pressed` buttons. That
    announces two independent toggles that happen to sit together, so a screen
    reader never says "1 of 2" and never tells you the set is exclusive.
  - bits' ToggleGroup looks like the obvious upgrade and is worse. For
    `type="single"` it puts `role="radio"` on the items but leaves the root at
    `role="group"` (inherited from Radix, whose issue this originally is).
    Orphaned radios are invalid ARIA: the positional announcement and the
    radio-group navigation both depend on a `radiogroup` ancestor, so you get
    the radio role with none of what the role buys.
  - RadioGroup is the same visual control with the pairing done correctly:
    `role="radiogroup"` + `role="radio"` + `aria-checked`, plus the roving
    tabindex and arrow keys the hand-written version lacked.

  Radios also cannot be un-checked by pressing the checked one, which deletes a
  guard the ToggleGroup version needed: "pick exactly one of N" is the semantics
  rather than something each call site has to defend (conduit-test-mkah).

  `type="button"` is set by hand because bits' RadioGroup.Item does not set it
  and a default-submit inside a form is a nasty thing to discover later. Its
  ToggleGroup.Item does set it, which is exactly how you forget.
-->
<script lang="ts" generics="T extends string">
	import { RadioGroup } from "bits-ui";
	import {
		SEGMENTED_VARIANTS,
		segmentedItemClass,
		type SegmentedOption,
		type SegmentedVariant,
	} from "./segmented-styles.js";

	let {
		value = $bindable(),
		options,
		variant = "field",
		label,
		class: className,
	}: {
		value: T;
		options: readonly SegmentedOption<T>[];
		variant?: SegmentedVariant;
		/** Names the group for screen readers, e.g. "Driver". */
		label: string;
		class?: string;
	} = $props();

	const recipe = $derived(SEGMENTED_VARIANTS[variant]);
</script>

<RadioGroup.Root
	{value}
	onValueChange={(next) => {
		value = next as T;
	}}
	orientation="horizontal"
	aria-label={label}
	class={[recipe.list, className].filter(Boolean).join(" ")}
>
	{#each options as option (option.value)}
		<RadioGroup.Item
			type="button"
			value={option.value}
			disabled={option.disabled}
			data-testid={option.testId}
			class={segmentedItemClass(variant, value === option.value)}
		>
			{option.label}
		</RadioGroup.Item>
	{/each}
</RadioGroup.Root>
