<script lang="ts">
	import type { HTMLButtonAttributes } from "svelte/elements";
	import Button from "./Button.svelte";
	import Icon from "./Icon.svelte";

	let {
		live = false,
		class: className = "",
		onclick = () => undefined,
		...rest
	}: { live?: boolean; class?: string; onclick?: (event: MouseEvent) => void } & Omit<HTMLButtonAttributes, "class" | "children" | "type" | "disabled" | "onclick" | "aria-label"> = $props();
</script>

<Button
	{...rest}
	{onclick}
	variant="ghost"
	size="content"
	tone={live ? "accent" : "secondary"}
	hoverFill="surface"
	touchTarget
	class="h-[28px] gap-[7px] rounded-full border border-border bg-popover-bg pl-[10px] pr-[12px] text-[12.5px] font-medium font-sans shadow-panel {className}"
>
	{#if live}<Icon name="loader-circle" size={11} class="animate-spin shrink-0" />{/if}
	{live ? "Jump to live" : "Latest"}
	<Icon name="arrow-down" size={13} class="shrink-0" />
</Button>
