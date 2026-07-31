<script lang="ts">
	import { DropdownMenu, type DropdownMenuSeparatorProps } from "bits-ui";

	type MenuSeparatorProps = {
		class?: string | undefined;
	} & Omit<
		DropdownMenuSeparatorProps,
		"child" | "children" | "class"
	>;

	let {
		class: className,
		...rest
	}: MenuSeparatorProps = $props();

	const separatorClass = $derived(
		["my-1 h-px bg-border", className].filter(Boolean).join(" "),
	);

	const separatorProps: Omit<
		DropdownMenuSeparatorProps,
		"child" | "children"
	> = $derived(rest);
</script>

<DropdownMenu.Separator {...separatorProps}>
	{#snippet child({ props })}
		<div {...props} role="separator" class={separatorClass}></div>
	{/snippet}
</DropdownMenu.Separator>
