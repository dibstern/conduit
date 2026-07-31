<script lang="ts">
	import { DropdownMenu, type DropdownMenuGroupProps } from "bits-ui";
	import type { Snippet } from "svelte";
	import { FLOATING_ITEM_PADDING_CLASSES } from "./floating-styles.js";

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
				class={`${FLOATING_ITEM_PADDING_CLASSES} text-xs font-medium text-text-muted`}
			>
				{label}
			</div>
		{/snippet}
	</DropdownMenu.GroupHeading>
	{@render children()}
</DropdownMenu.Group>
