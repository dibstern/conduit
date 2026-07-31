<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
	import Icon from "./Icon.svelte";
	import {
		FLOATING_ITEM_CLASSES,
		MENU_RADIO_ITEM_COLOR_CLASSES,
	} from "./floating-styles.js";

	type MenuRadioItemProps = {
		value: string;
		disabled?: boolean;
		closeOnSelect?: boolean;
		onselect?: (event: Event) => void;
		class?: string;
		children: Snippet;
	} & Omit<
		HTMLAttributes<HTMLDivElement>,
		| "class"
		| "children"
		| "role"
		| "aria-checked"
		| "aria-disabled"
		| "onselect"
	>;

	let {
		value,
		disabled = false,
		closeOnSelect = true,
		onselect,
		class: className,
		children,
		...rest
	}: MenuRadioItemProps = $props();

	const itemClass = $derived(
		[
			FLOATING_ITEM_CLASSES,
			`justify-between ${MENU_RADIO_ITEM_COLOR_CLASSES}`,
			className,
		]
			.filter(Boolean)
			.join(" "),
	);
</script>

<DropdownMenu.RadioItem
	{...rest}
	{value}
	{disabled}
	{closeOnSelect}
	onSelect={onselect}
	class={itemClass}
>
	{#snippet child({ props, checked })}
		<div {...props}>
			<span class="min-w-0 flex-1">
				{@render children()}
			</span>
			{#if checked}
				<span
					aria-hidden="true"
					data-menu-radio-check
					class="shrink-0 text-accent"
				>
					<Icon name="check" size={14} />
				</span>
			{/if}
		</div>
	{/snippet}
</DropdownMenu.RadioItem>
