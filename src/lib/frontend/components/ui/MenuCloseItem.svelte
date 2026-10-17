<script lang="ts">
	import { DropdownMenu, type DropdownMenuItemProps } from "bits-ui";
	import Button from "./Button.svelte";

	// Choosing any menu item closes the menu, so closing needs no handler and keeps the menu's own focus return.
	let { label, ...rest }: { label: string } & Omit<DropdownMenuItemProps, "children" | "child" | "textValue"> = $props();
</script>

<DropdownMenu.Item {...rest} textValue={label}>
	{#snippet child({ props })}
		<Button {...props} variant="ghost" size="content" iconOnly icon="x" iconSize={14} ariaLabel={label} touchTarget class="size-[32px] shrink-0 justify-center rounded-full bg-chip" />
	{/snippet}
</DropdownMenu.Item>
