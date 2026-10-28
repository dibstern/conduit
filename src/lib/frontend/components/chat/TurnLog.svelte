<script lang="ts">
	import { tick, type Snippet } from "svelte";
	import type { PendingReveal } from "../../stores/turn-panel.svelte.js";
	import type { TurnLogEntry, TurnPhase } from "../../utils/turns.js";
	import Button from "../ui/Button.svelte";

	let { class: className, mode, phase, pending, stepCount, entries, row, footer }: {
		class: string;
		mode: "collapsed" | "hidden" | "shown";
		phase: TurnPhase;
		pending: PendingReveal | null;
		stepCount: number;
		entries: readonly TurnLogEntry[];
		row: Snippet<[TurnLogEntry]>;
		footer: Snippet;
	} = $props();
	// A Turn keeps its reader's choice through collapse and phase changes.
	let choice = $state<"ticker" | "all" | null>(null);
	const rowMode = $derived(phase === "settled" ? "all" : choice ?? "ticker");
	const steps = $derived(entries.filter((entry) => entry.kind === "step" && entry.part.type !== "system"));
	const earlierCount = $derived(Math.max(0, steps.length - 3));
	const earlierIndex = $derived(steps[earlierCount]?.index ?? 0);
	let logEl: HTMLDivElement | undefined = $state();
	$effect(() => { if (pending?.target.kind === "step") choice = "all"; });
	// Keep shown rows mounted when leaving Full log so row details survive.
	let logMounted = $state(false);
	$effect(() => { if (mode === "shown" && rowMode === "all") logMounted = true; });
	const visibleEntries = $derived(logMounted || rowMode === "all" ? entries : entries.filter((entry) => entry.index >= earlierIndex));
	async function toggleEarlier() {
		const row = logEl ? [...logEl.querySelectorAll("[data-log-part]")].at(-1) : undefined;
		const before = row?.getBoundingClientRect().top;
		const scroller = logEl?.closest('[aria-label="Transcript"]');
		choice = rowMode === "ticker" ? "all" : "ticker";
		await tick();
		// A reveal or unmount supersedes this reader's scroll anchor.
		if (before === undefined || mode !== "shown" || pending || !row?.isConnected || !scroller?.isConnected) return;
		scroller.scrollTop += row.getBoundingClientRect().top - before;
	}
</script>

{#if mode !== "collapsed" && (logMounted || mode === "shown")}
	<div bind:this={logEl} class={className} role="region" aria-label={`Turn log, ${stepCount} steps`} hidden={mode === "hidden"} data-testid={phase !== "settled" ? "turn-live-activity" : undefined}>
		{#if phase !== "settled" && earlierCount > 0}
			<Button variant="ghost" size="content" tone="secondary" hoverFill="none" align="start" touchTarget
				class="px-[6px] py-[7px] text-[12px]" aria-expanded={rowMode === "all"} onclick={toggleEarlier}>{rowMode === "ticker" ? `+ ${earlierCount} earlier steps` : "Hide earlier steps"}</Button>
		{/if}
		{#each visibleEntries as entry (entry.uuid)}
			<div hidden={rowMode === "ticker" && entry.index < earlierIndex}>{@render row(entry)}</div>
		{/each}
		{@render footer()}
	</div>
{/if}
