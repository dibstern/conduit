<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
	import { FLOATING_ITEM_PADDING_CLASSES } from "./floating-styles.js";

	type MenuGroupProps = {
		label: string;
		class?: string;
		children: Snippet;
	} & Omit<
		HTMLAttributes<HTMLDivElement>,
		"class" | "children" | "role"
	>;

	let {
		label,
		class: className,
		children,
		...rest
	}: MenuGroupProps = $props();
</script>

<DropdownMenu.Group {...rest} class={className}>
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
