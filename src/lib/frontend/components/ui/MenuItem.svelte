<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import type { Snippet } from "svelte";
	import type { HTMLAnchorAttributes, HTMLAttributes } from "svelte/elements";
	import {
		FLOATING_ITEM_CLASSES,
		MENU_ITEM_VARIANT_CLASSES,
	} from "./floating-styles.js";

	type MenuItemVariant = keyof typeof MENU_ITEM_VARIANT_CLASSES;

	type MenuItemOwnProps = {
		variant?: MenuItemVariant;
		disabled?: boolean;
		textValue?: string;
		closeOnSelect?: boolean;
		onselect?: (event: Event) => void;
		class?: string;
		children: Snippet;
	};

	type MenuItemProps =
		| (MenuItemOwnProps &
				Omit<
					HTMLAnchorAttributes,
					| "class"
					| "children"
					| "href"
					| "role"
					| "aria-disabled"
					| "onselect"
				> & { href: HTMLAnchorAttributes["href"] })
		| (MenuItemOwnProps &
				Omit<
					HTMLAttributes<HTMLDivElement>,
					"class" | "children" | "role" | "aria-disabled" | "onselect"
				> & { href?: undefined });

	let {
		variant = "default",
		disabled = false,
		textValue,
		href,
		closeOnSelect = true,
		onselect,
		class: className,
		children,
		...rest
	}: MenuItemProps = $props();

	const itemClass = $derived(
		[FLOATING_ITEM_CLASSES, MENU_ITEM_VARIANT_CLASSES[variant], className]
			.filter(Boolean)
			.join(" "),
	);
</script>

<DropdownMenu.Item
	{...rest}
	{disabled}
	{closeOnSelect}
	onSelect={onselect}
	class={itemClass}
>
	{#snippet child({ props })}
		{#if href !== undefined}
			<a {...props} {href}>
				{#if textValue}
					<span class="sr-only" aria-hidden="true" data-menu-text-value>
						{textValue}
					</span>
				{/if}
				{@render children()}
			</a>
		{:else}
			<div {...props}>
				{#if textValue}
					<span class="sr-only" aria-hidden="true" data-menu-text-value>
						{textValue}
					</span>
				{/if}
				{@render children()}
			</div>
		{/if}
	{/snippet}
</DropdownMenu.Item>
