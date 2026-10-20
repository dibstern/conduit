<!--
  Tabs — a strip of options where picking one swaps the panel below it.

  Two files hand-wrote a tab strip and neither had any of the keyboard or
  screen-reader contract a tab strip owes: no `role="tablist"`, no
  `role="tab"`, no `aria-selected`, no roving tabindex, no arrow keys. Five
  settings tabs and a Unified/Split switch were, to assistive tech, six
  unrelated buttons.

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
	import type { Snippet } from "svelte";
	import { Tabs } from "bits-ui";
	import Icon from "./Icon.svelte";
	import {
		SEGMENTED_VARIANTS,
		segmentedItemClass,
		type SegmentedOption,
		type SegmentedVariant,
	} from "./segmented-styles.js";

	type TabOption = SegmentedOption<T> & {
		groupLabel?: string;
		icon?: string;
		iconTone?: "neutral" | "purple" | "clay" | "amber" | "green";
	};
	const iconTones = {
		neutral: "max-md:bg-settings-tile-neutral",
		purple: "max-md:bg-settings-tile-purple",
		clay: "max-md:bg-settings-tile-clay",
		amber: "max-md:bg-settings-tile-amber",
		green: "max-md:bg-settings-tile-green",
	};

	let {
		value = $bindable(),
		options,
		variant = "underline",
		orientation = "horizontal",
		activationMode = "automatic",
		label,
		class: className,
		optionContent,
		onValueChange,
	}: {
		/** The selected tab's value. */
		value: T;
		/**
		 * `groupLabel` prints a small heading above that option, e.g. Settings'
		 * "This computer". It is decorative: the tabs keep their own names.
		 */
		options: readonly TabOption[];
		variant?: SegmentedVariant;
		/**
		 * `vertical` is a section list: ArrowUp/ArrowDown move (Left/Right do
		 * not), and the list announces `aria-orientation="vertical"`.
		 */
		orientation?: "horizontal" | "vertical";
		/**
		 * `manual` makes arrows move focus only, selecting on Enter/Space or a
		 * click. For lists where selecting navigates away, such as Settings'
		 * phone section list, which drills into the section.
		 */
		activationMode?: "automatic" | "manual";
		/** Names the strip for screen readers, e.g. "Settings sections". */
		label: string;
		/** Additional classes for the strip element. */
		class?: string;
		/** Custom contents for each tab; the label remains its accessible name. */
		optionContent?: Snippet<[SegmentedOption<T>, boolean]>;
		onValueChange?: (value: T) => void;
	} = $props();

	const recipe = $derived(SEGMENTED_VARIANTS[variant]);
	const sections = $derived.by(() => {
		const groups: { label?: string; options: TabOption[] }[] = [];
		for (const option of options) {
			if (!groups.length || option.groupLabel) {
				groups.push({ ...(option.groupLabel ? { label: option.groupLabel } : {}), options: [] });
			}
			groups[groups.length - 1]?.options.push(option);
		}
		return groups;
	});
</script>

{#snippet trigger(option: TabOption)}
	<Tabs.Trigger
		value={option.value}
		disabled={option.disabled}
		data-testid={option.testId}
		aria-label={optionContent || option.icon ? option.label : undefined}
		class={segmentedItemClass(variant, value === option.value)}
	>
		{#if option.icon}
			<span aria-hidden="true" class="flex size-[15px] shrink-0 items-center justify-center {variant === 'sections' ? 'text-settings-icon' : 'text-text-dimmer'} group-data-[state=active]:text-text [&_g]:fill-current max-md:size-[28px] max-md:rounded-[8px] max-md:text-white {iconTones[option.iconTone ?? 'neutral']}">
				<Icon name={option.icon} size={15} />
			</span>
		{/if}
		{#if optionContent}
			{@render optionContent(option, value === option.value)}
		{:else}
			{option.label}
		{/if}
	</Tabs.Trigger>
{/snippet}

<!--
  bits' Root is a plain wrapper div with no styling of its own; the strip
  classes go on the List, which is the element that was there before.
-->
<Tabs.Root
	{value}
	{orientation}
	{activationMode}
	onValueChange={(next) => {
		value = next as T;
		onValueChange?.(value);
	}}
>
	<Tabs.List
		aria-label={label}
		class={[recipe.list, className].filter(Boolean).join(" ")}
	>
		{#if variant === "sections"}
			{#each sections as section, index (index)}
				{#if section.label}
					<div aria-hidden="true" data-testid="tabs-group-label" class="mt-[16px] mb-[4px] px-[10px] text-[11.5px] font-medium text-text-dimmer max-md:mt-[18px] max-md:mb-[6px] max-md:px-[4px] max-md:text-[13px]">{section.label}</div>
				{/if}
				<div class="flex flex-col max-md:overflow-hidden max-md:rounded-[12px] max-md:bg-settings-card max-md:divide-y max-md:divide-settings-separator">
					{#each section.options as option (option.value)}{@render trigger(option)}{/each}
				</div>
			{/each}
		{:else}
			{#each options as option (option.value)}
				{#if option.groupLabel}
					<div aria-hidden="true" data-testid="tabs-group-label" class="mt-[12px] mb-[4px] px-[8px] text-[10px] font-semibold uppercase tracking-[0.09em] leading-[15px] text-text-dimmer">{option.groupLabel}</div>
				{/if}
				{@render trigger(option)}
			{/each}
		{/if}
	</Tabs.List>
</Tabs.Root>
