<script lang="ts">
	import { DropdownMenu, type DropdownMenuGroupProps } from "bits-ui";
	import type { Snippet } from "svelte";

	let { label, children, class: className = "", ...rest }: {
		label: string;
		children: Snippet;
	} & Omit<DropdownMenuGroupProps, "child" | "children"> = $props();
</script>

<DropdownMenu.Group {...rest} class={className}>
	<DropdownMenu.GroupHeading class="mt-[18px] mx-[2px] mb-[8px] text-[12.5px] font-medium text-text-dimmer">{label}</DropdownMenu.GroupHeading>
	<div data-menu-grid class="grid grid-cols-4 gap-[8px]">{@render children()}</div>
</DropdownMenu.Group>
