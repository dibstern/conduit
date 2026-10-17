<script lang="ts">
	import { DropdownMenu, type DropdownMenuGroupProps } from "bits-ui";
	import type { Snippet } from "svelte";

	let { label, columns = 4, children, class: className = "", ...rest }: {
		label: string;
		columns?: 4 | 5;
		children: Snippet;
	} & Omit<DropdownMenuGroupProps, "child" | "children"> = $props();
</script>

<DropdownMenu.Group {...rest} class={className}>
	<DropdownMenu.GroupHeading class="mt-[18px] mx-[2px] mb-[8px] text-[12.5px] font-medium text-text-muted">{label}</DropdownMenu.GroupHeading>
	<div data-menu-grid class="grid {columns === 5 ? 'grid-cols-5 gap-[6px] [--tile-font:12px]' : 'grid-cols-4 gap-[8px]'}">{@render children()}</div>
</DropdownMenu.Group>
