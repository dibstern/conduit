<script lang="ts">
	import type { Snippet } from "svelte";
	import type { TurnLogEntry } from "../../utils/turns.js";
	import Button from "../ui/Button.svelte";

	let { class: className, mode, live, earlierCount, earlierIndex, stepCount, entries, row, footer, onopen }: {
		class: string;
		mode: "collapsed" | "hidden" | "ticker" | "full";
		live: boolean;
		earlierCount: number;
		earlierIndex: number;
		stepCount: number;
		entries: readonly TurnLogEntry[];
		row: Snippet<[TurnLogEntry]>;
		footer: Snippet;
		onopen: () => void;
	} = $props();
	// Keep shown rows mounted when leaving Full log so row details survive.
	let logMounted = $state(false);
	$effect(() => { if (mode === "full") logMounted = true; });
	const visibleEntries = $derived(logMounted || mode === "full" ? entries : entries.filter((entry) => entry.index >= earlierIndex));
</script>

{#if mode !== "collapsed" && (logMounted || mode === "full" || mode === "ticker")}
	<div class={className} role="region" aria-label={`Turn log, ${stepCount} steps`} hidden={mode === "hidden"} data-testid={live ? "turn-live-activity" : undefined}>
		{#if mode !== "full" && earlierCount > 0}
			<Button variant="ghost" size="content" tone="muted" hoverFill="none" align="start" touchTarget
				class="py-[8px] text-[12px]" onclick={onopen}>+ {earlierCount} earlier messages</Button>
		{/if}
		{#each visibleEntries as entry (entry.uuid)}{@render row(entry)}{/each}
		{@render footer()}
	</div>
{/if}
