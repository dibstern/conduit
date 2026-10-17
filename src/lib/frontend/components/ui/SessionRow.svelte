<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAnchorAttributes } from "svelte/elements";

	let {
		active = false,
		selected = false,
		selectMode = false,
		density = "comfortable",
		dragging = false,
		offset = 0,
		element = $bindable(),
		children,
		...rest
	}: Omit<HTMLAnchorAttributes, "class" | "style" | "children"> & {
		active?: boolean;
		selected?: boolean;
		selectMode?: boolean;
		density?: "comfortable" | "dense";
		dragging?: boolean;
		offset?: number;
		element?: HTMLAnchorElement | undefined;
		children: Snippet;
	} = $props();
</script>

<a
	{...rest}
	bind:this={element}
	class="session-item group relative grid min-h-[44px] cursor-pointer select-none items-center gap-x-[10px] gap-y-px rounded-[9px] px-[10px] text-[15px] leading-[19px] text-text-secondary no-underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent md:text-[13px] md:leading-[17px] {selectMode ? 'grid-cols-[44px_minmax(0,1fr)_auto]' : 'grid-cols-[14px_minmax(0,1fr)_auto]'} {density === 'dense' ? 'py-[4px]' : 'py-[8px] md:py-[6px]'} {active || selected ? 'bg-selection' : offset !== 0 ? 'bg-sidebar-bg' : 'hover:bg-hover'} {dragging ? 'transition-none' : 'transition-[color,background-color,transform] duration-150 motion-reduce:transition-none'}"
	class:active
	style:touch-action="pan-y"
	style:-webkit-touch-callout="none"
	style:transform="translateX({offset}px)"
>
	{@render children()}
</a>
