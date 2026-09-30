<script lang="ts">
	import { DropdownMenu, type DropdownMenuItemProps } from "bits-ui";
	import { getContext, type Snippet } from "svelte";
	import type { HTMLAnchorAttributes, HTMLAttributes } from "svelte/elements";
	import Icon from "./Icon.svelte";
	import {
		FLOATING_ITEM_BASE_CLASSES,
		MENU_ITEM_DENSITY_CLASSES,
		MENU_ITEM_VARIANT_CLASSES,
		MENU_SHEET_LEADING_ICON_CLASSES,
		type MenuItemDensity,
	} from "./floating-styles.js";
	import { menuDensityContextKey, type MenuDensityContext } from "./menu-context.js";

	type MenuItemVariant = keyof typeof MENU_ITEM_VARIANT_CLASSES;
	type MenuAnchorAttributes = Omit<
		HTMLAnchorAttributes,
		keyof HTMLAttributes<HTMLElement>
	> &
		HTMLAttributes<HTMLElement>;

	type MenuItemVariantProps = {
		variant?: MenuItemVariant | undefined;
		icon?: string | undefined;
	};

	type MenuItemOwnProps = MenuItemVariantProps & {
		density?: MenuItemDensity | undefined;
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
		density,
		icon,
		disabled = false,
		href,
		id,
		closeOnSelect = true,
		onselect,
		class: className,
		children,
		...rest
	}: MenuItemProps = $props();
	const menuDensity = getContext<MenuDensityContext | undefined>(menuDensityContextKey);
	const resolvedDensity = $derived(density ?? menuDensity?.() ?? "default");

	const itemClass = $derived(
		[
			FLOATING_ITEM_BASE_CLASSES,
			MENU_ITEM_DENSITY_CLASSES[resolvedDensity],
			MENU_ITEM_VARIANT_CLASSES[variant],
			className,
		]
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

{#snippet itemContent()}
	{#if resolvedDensity === "sheet"}
		<span aria-hidden="true" data-menu-item-icon class={`${MENU_SHEET_LEADING_ICON_CLASSES} ${variant === "danger" ? "text-error" : "text-text-secondary"}`}>
			{#if icon || variant === "danger"}<Icon name={icon ?? "trash-2"} size={15} />{/if}
		</span>
	{:else if variant === "danger"}
		<span aria-hidden="true" data-menu-item-icon class="shrink-0">
			<Icon name={icon ?? "trash-2"} size={13} />
		</span>
	{/if}
	{@render children()}
{/snippet}

<DropdownMenu.Item {...itemProps}>
	{#snippet child({ props })}
		{#if href !== undefined}
			<a {...props} {href}>
				{@render itemContent()}
			</a>
		{:else}
			<div {...props}>
				{@render itemContent()}
			</div>
		{/if}
	{/snippet}
</DropdownMenu.Item>
