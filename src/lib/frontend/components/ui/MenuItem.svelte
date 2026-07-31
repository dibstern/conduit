<script lang="ts">
	import { DropdownMenu, type DropdownMenuItemProps } from "bits-ui";
	import type { Snippet } from "svelte";
	import type { HTMLAnchorAttributes, HTMLAttributes } from "svelte/elements";
	import {
		FLOATING_ITEM_CLASSES,
		MENU_ITEM_VARIANT_CLASSES,
	} from "./floating-styles.js";

	type MenuItemVariant = keyof typeof MENU_ITEM_VARIANT_CLASSES;
	type MenuAnchorAttributes = Omit<
		HTMLAnchorAttributes,
		keyof HTMLAttributes<HTMLElement>
	> &
		HTMLAttributes<HTMLElement>;

	type MenuItemOwnProps = {
		variant?: MenuItemVariant | undefined;
		disabled?: boolean | undefined;
		closeOnSelect?: boolean | undefined;
		onselect?: ((event: Event) => void) | undefined;
		class?: string | undefined;
		id?: string | undefined;
		children: Snippet;
	};

	type MenuItemProps =
		| (MenuItemOwnProps &
				Omit<
					MenuAnchorAttributes,
					| "class"
					| "children"
					| "href"
					| "id"
					| "role"
					| "aria-disabled"
					| "onselect"
				> & { href: HTMLAnchorAttributes["href"] })
		| (MenuItemOwnProps &
				Omit<
					HTMLAttributes<HTMLDivElement>,
					| "class"
					| "children"
					| "id"
					| "role"
					| "aria-disabled"
					| "onselect"
				> & { href?: undefined });

	let {
		variant = "default",
		disabled = false,
		href,
		id,
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

	function handleSelect(event: Event) {
		onselect?.(event);
	}

	const itemProps: Omit<
		DropdownMenuItemProps,
		"child" | "children"
	> = $derived({
		...rest,
		...(id === undefined ? {} : { id }),
		disabled,
		closeOnSelect,
		onSelect: handleSelect,
		class: itemClass,
	});
</script>

<DropdownMenu.Item {...itemProps}>
	{#snippet child({ props })}
		{#if href !== undefined}
			<a {...props} {href}>
				{@render children()}
			</a>
		{:else}
			<div {...props}>
				{@render children()}
			</div>
		{/if}
	{/snippet}
</DropdownMenu.Item>
