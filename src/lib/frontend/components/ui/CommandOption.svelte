<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
	import Icon from "./Icon.svelte";
	let { active = false, goal = false, icon, children, ...rest }: {
		active?: boolean;
		goal?: boolean;
		icon: string;
		children: Snippet;
	} & Omit<HTMLAttributes<HTMLDivElement>, "children"> = $props();
</script>

<div {...rest} role="option" aria-selected={active} tabindex="-1" data-active={active} data-goal={goal} class="command-option">
	<Icon name={icon} size={17} class="shrink-0" />
	{@render children()}
</div>

<style>
	.command-option { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 6px 10px; border-radius: 10px; cursor: pointer; color: var(--color-text-muted); }
	.command-option:hover, [data-active="true"] { background: var(--color-hover); }
	[data-goal="true"] { color: var(--color-status-goal); }
</style>
