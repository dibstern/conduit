<!-- Multiple pressed controls. The caller owns state; bits-ui owns keyboard and ARIA behavior. -->
<script lang="ts" generics="T extends string">
	import type { Snippet } from "svelte";
	import { ToggleGroup } from "bits-ui";
	import Tooltip from "./Tooltip.svelte";
	import {
		SEGMENTED_VARIANTS,
		segmentedItemClass,
		type SegmentedOption,
		type SegmentedVariant,
	} from "./segmented-styles.js";

	let {
		value,
		options,
		variant = "switcher",
		label,
		optionContent,
		onToggle,
		orientation = "horizontal",
	}: {
		value: readonly T[];
		options: readonly SegmentedOption<T>[];
		variant?: SegmentedVariant | undefined;
		label: string;
		optionContent?: Snippet<[SegmentedOption<T>, boolean]> | undefined;
		onToggle: (value: T) => void;
		orientation?: "horizontal" | "vertical" | undefined;
	} = $props();

	const recipe = $derived(SEGMENTED_VARIANTS[variant]);
</script>

<ToggleGroup.Root
	type="multiple"
	{orientation}
	value={[...value]}
	aria-label={label}
	class={recipe.list}
	onValueChange={(next) => {
		const changed = options.find((option) => next.includes(option.value) !== value.includes(option.value));
		if (changed && !changed.disabled) onToggle(changed.value);
	}}
>
	{#each options as option (option.value)}
		{#snippet item(triggerProps: Record<string, unknown> = {})}
		<ToggleGroup.Item
			{...triggerProps}
			value={option.value}
			type="button"
			disabled={option.disabled}
			data-testid={option.testId}
			aria-label={option.label}
			class={`${segmentedItemClass(variant, value.includes(option.value))} focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text`}
		>
			{#if optionContent}
				{@render optionContent(option, value.includes(option.value))}
			{:else}
				{option.label}
			{/if}
		</ToggleGroup.Item>
		{/snippet}
		{#if variant === "rail"}
			<Tooltip side="left" delayDuration={300}>
				{#snippet trigger({ props })}{@render item(props)}{/snippet}
				{#snippet children()}{option.label}{/snippet}
			</Tooltip>
		{:else}
			{@render item()}
		{/if}
	{/each}
</ToggleGroup.Root>
