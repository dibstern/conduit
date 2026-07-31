<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import type { HTMLAttributes } from "svelte/elements";

	type MenuSeparatorProps = {
		class?: string;
	} & Omit<
		HTMLAttributes<HTMLDivElement>,
		"class" | "children" | "role"
	>;

	let {
		class: className,
		...rest
	}: MenuSeparatorProps = $props();

	const separatorClass = $derived(
		["my-1 h-px bg-border", className].filter(Boolean).join(" "),
	);
</script>

<DropdownMenu.Separator {...rest}>
	{#snippet child({ props })}
		<div {...props} role="separator" class={separatorClass}></div>
	{/snippet}
</DropdownMenu.Separator>
