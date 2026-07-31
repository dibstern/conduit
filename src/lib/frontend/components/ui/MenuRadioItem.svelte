<script lang="ts">
	import { DropdownMenu, type DropdownMenuRadioItemProps } from "bits-ui";
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";
	import {
		FLOATING_ITEM_CLASSES,
		MENU_RADIO_ITEM_COLOR_CLASSES,
	} from "./floating-styles.js";

	type MenuRadioItemProps = {
		value: string;
		disabled?: boolean | undefined;
		closeOnSelect?: boolean | undefined;
		onselect?: ((event: Event) => void) | undefined;
		class?: string | undefined;
		children: Snippet;
	} & Omit<
		DropdownMenuRadioItemProps,
		| "class"
		| "child"
		| "children"
		| "closeOnSelect"
		| "disabled"
		| "onSelect"
		| "value"
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

	function handleSelect(event: Event) {
		onselect?.(event);
	}

	const radioItemProps: Omit<
		DropdownMenuRadioItemProps,
		"child" | "children"
	> = $derived({
		...rest,
		value,
		disabled,
		closeOnSelect,
		onSelect: handleSelect,
		class: itemClass,
	});
</script>

<DropdownMenu.RadioItem {...radioItemProps}>
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
