<script lang="ts">
	import { DropdownMenu, type DropdownMenuGroupProps } from "bits-ui";
	import { getContext, type Snippet } from "svelte";
	import { FLOATING_ITEM_PADDING_CLASSES } from "./floating-styles.js";
	import { menuDensityContextKey, type MenuDensityContext } from "./menu-context.js";

	type MenuGroupProps = {
		label: string;
		class?: string | undefined;
		children: Snippet;
	} & Omit<
		DropdownMenuGroupProps,
		"child" | "children" | "class"
	>;

	let {
		label,
		class: className,
		children,
		...rest
	}: MenuGroupProps = $props();
	const menuDensity = getContext<MenuDensityContext | undefined>(menuDensityContextKey);

	const groupProps: Omit<
		DropdownMenuGroupProps,
		"child" | "children"
	> = $derived({
		...rest,
		...(className === undefined ? {} : { class: className }),
	});
</script>

<DropdownMenu.Group {...groupProps}>
	<DropdownMenu.GroupHeading>
		{#snippet child({ props })}
			<div
				{...props}
				role="presentation"
				class={menuDensity?.() === "sheet"
					? "px-4 pb-[5px] pt-[10px] font-mono text-[10.5px] font-semibold uppercase leading-none tracking-[0.1em] text-text-muted"
					: `${FLOATING_ITEM_PADDING_CLASSES} text-xs font-medium text-text-muted`}
			>
				{label}
			</div>
		{/snippet}
	</DropdownMenu.GroupHeading>
	{@render children()}
</DropdownMenu.Group>
