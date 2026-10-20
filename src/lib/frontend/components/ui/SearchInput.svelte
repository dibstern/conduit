<script lang="ts">
	import type { HTMLInputAttributes } from "svelte/elements";
	import Icon from "./Icon.svelte";

	let { element = $bindable(), value = "", shortcut, ...rest }: Omit<HTMLInputAttributes, "class" | "size" | "type" | "value"> & {
		element?: HTMLInputElement | undefined;
		value?: string;
		shortcut?: string;
	} = $props();
</script>

<span class="relative flex h-[30px] min-w-0 flex-1 items-center gap-[6px] rounded-[9px] bg-chip px-[9px] text-[12.5px] text-text-dimmer focus-within:ring-1 focus-within:ring-border-chip">
	<Icon name="search" size={12} class="shrink-0" />
	<input {...rest} bind:this={element} {value} type="text" class="min-h-[44px] min-w-0 flex-1 self-center bg-transparent font-sans text-[12.5px] text-text outline-none placeholder:text-text-dimmer md:min-h-[30px]" />
	{#if shortcut && value === ""}<kbd class="pointer-events-none shrink-0 font-mono text-[10.5px] @max-[210px]/sidebar:hidden" aria-hidden="true">{shortcut}</kbd>{/if}
</span>
