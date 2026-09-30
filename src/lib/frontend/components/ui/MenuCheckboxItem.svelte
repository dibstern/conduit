<script lang="ts">
	import { DropdownMenu, type DropdownMenuCheckboxItemProps } from "bits-ui";
	import { getContext, type Snippet } from "svelte";
	import Icon from "./Icon.svelte";
	import {
		FLOATING_ITEM_BASE_CLASSES,
		MENU_ITEM_DENSITY_CLASSES,
		MENU_ITEM_VARIANT_CLASSES,
		MENU_SHEET_LEADING_ICON_CLASSES,
		type MenuItemDensity,
	} from "./floating-styles.js";
	import { menuDensityContextKey, type MenuDensityContext } from "./menu-context.js";

	type MenuCheckboxItemProps = {
		checked: boolean;
		icon?: string | undefined;
		density?: MenuItemDensity | undefined;
		disabled?: boolean | undefined;
		closeOnSelect?: boolean | undefined;
		onselect?: ((event: Event) => void) | undefined;
		class?: string | undefined;
		children: Snippet;
	} & Omit<
		DropdownMenuCheckboxItemProps,
		| "checked"
		| "class"
		| "child"
		| "children"
		| "closeOnSelect"
		| "disabled"
		| "onCheckedChange"
		| "onSelect"
	>;

	let {
		checked = $bindable(),
		icon,
		density,
		disabled = false,
		closeOnSelect = true,
		onselect,
		class: className,
		children,
		...rest
	}: MenuCheckboxItemProps = $props();
	const menuDensity = getContext<MenuDensityContext | undefined>(menuDensityContextKey);
	const resolvedDensity = $derived(density ?? menuDensity?.() ?? "default");

	const itemClass = $derived(
		[
			FLOATING_ITEM_BASE_CLASSES,
			MENU_ITEM_DENSITY_CLASSES[resolvedDensity],
			MENU_ITEM_VARIANT_CLASSES.default,
			className,
		]
			.filter(Boolean)
			.join(" "),
	);

	const checkboxItemProps: Omit<
		DropdownMenuCheckboxItemProps,
		"child" | "children"
	> = $derived({
		...rest,
		checked,
		disabled,
		closeOnSelect,
		onCheckedChange: (nextChecked: boolean) => { checked = nextChecked; },
		onSelect: (event: Event) => { onselect?.(event); },
		class: itemClass,
	});
</script>

<DropdownMenu.CheckboxItem {...checkboxItemProps}>
	{#snippet child({ props, checked: itemChecked })}
		<!-- The box sits at the tail, like MenuRadioItem's check, so it never reads
		     as the leading icon of a neighbouring item. -->
		<div {...props}>
			{#if resolvedDensity === "sheet"}
				<span aria-hidden="true" class={`${MENU_SHEET_LEADING_ICON_CLASSES} text-text-secondary`}>
					{#if icon}<Icon name={icon} size={15} />{/if}
				</span>
			{/if}
			{@render children()}
			<span
				class="ml-auto grid size-[16px] shrink-0 place-items-center rounded-[5px] border-[1.5px] {itemChecked ? 'border-accent bg-accent text-on-brand' : 'border-border-chip'}"
				aria-hidden="true"
			>
				{#if itemChecked}<Icon name="check" size={10} />{/if}
			</span>
		</div>
	{/snippet}
</DropdownMenu.CheckboxItem>
