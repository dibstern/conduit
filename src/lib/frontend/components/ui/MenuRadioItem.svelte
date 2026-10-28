<script lang="ts">
	import { DropdownMenu, type DropdownMenuRadioItemProps } from "bits-ui";
	import { getContext, type Snippet } from "svelte";
	import Icon from "./Icon.svelte";
	import {
		FLOATING_ITEM_BASE_CLASSES,
		MENU_ITEM_DENSITY_CLASSES,
		MENU_RADIO_ITEM_COLOR_CLASSES,
		MENU_SHEET_LEADING_ICON_CLASSES,
	} from "./floating-styles.js";
	import { menuDensityContextKey, type MenuDensityContext } from "./menu-context.js";

	type MenuRadioItemProps = {
		value: string;
		icon?: string | undefined;
		indicatorPosition?: "leading" | "trailing";
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
		icon,
		indicatorPosition = "trailing",
		disabled = false,
		closeOnSelect = true,
		onselect,
		class: className,
		children,
		...rest
	}: MenuRadioItemProps = $props();
	const menuDensity = getContext<MenuDensityContext | undefined>(menuDensityContextKey);
	const density = $derived(menuDensity?.() ?? "default");

	const itemClass = $derived(
		[
			FLOATING_ITEM_BASE_CLASSES,
			MENU_ITEM_DENSITY_CLASSES[density],
			indicatorPosition === "leading"
				? "data-[state=unchecked]:text-text data-[state=checked]:text-text data-[state=checked]:bg-selection data-[state=unchecked]:hover:bg-bg data-[state=unchecked]:focus:bg-bg"
				: `justify-between ${MENU_RADIO_ITEM_COLOR_CLASSES}`,
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
			{#if indicatorPosition === "leading"}
				<span aria-hidden="true" class="grid w-[14px] shrink-0 place-items-center text-accent">
					{#if checked}<Icon name="check" size={14} />{/if}
				</span>
			{:else if density === "sheet"}
				<span aria-hidden="true" class={`${MENU_SHEET_LEADING_ICON_CLASSES} ${checked ? "text-accent" : "text-text-secondary"}`}>
					{#if icon}<Icon name={icon} size={15} />{/if}
				</span>
			{/if}
			<span class="min-w-0 flex-1">
				{@render children()}
			</span>
			{#if checked && indicatorPosition === "trailing"}
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
