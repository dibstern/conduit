<script lang="ts">
	import type { Snippet } from "svelte";
	import { on } from "svelte/events";
	import { anchorTop, type ScrollController } from "../../stores/scroll-controller.svelte.js";
	import type { PendingReveal } from "../../stores/turn-panel.svelte.js";
	import { plural, type TurnLogEntry, type TurnPhase } from "../../utils/turns.js";
	import Button from "../ui/Button.svelte";

	let { class: className, mode, phase, pending, stepCount, entries, row, onreposition }: {
		class: string;
		mode: "collapsed" | "hidden" | "shown";
		phase: TurnPhase;
		pending: PendingReveal | null;
		stepCount: number;
		entries: readonly TurnLogEntry[];
		row: Snippet<[TurnLogEntry]>;
		onreposition: ScrollController["reposition"];
	} = $props();
	// A Turn keeps its reader's choice through collapse and phase changes.
	let choice = $state<"ticker" | "all" | null>(null);
	const rowMode = $derived(phase === "settled" ? "all" : choice ?? "ticker");
	const steps = $derived(entries.filter((entry) => entry.kind === "step" && entry.part.type !== "system"));
	const earlierCount = $derived(Math.max(0, steps.length - 3));
	const earlierIndex = $derived(steps[earlierCount]?.index ?? 0);
	let logEl: HTMLDivElement | undefined = $state();
	$effect(() => { if (pending?.target.kind === "step") choice = "all"; });
	// Keep shown rows mounted when the log is hidden or the turn collapses, so row details survive.
	let logMounted = $state(false);
	$effect(() => { if (mode === "shown" && rowMode === "all") logMounted = true; });
	const visibleEntries = $derived(logMounted || rowMode === "all" ? entries : entries.filter((entry) => entry.index >= earlierIndex));
	async function toggleEarlier() {
		const row = rowMode === "ticker"
			? [...(logEl?.querySelectorAll("[data-log-part]") ?? [])].at(-1)
			: logEl?.querySelector("button");
		const before = row?.getBoundingClientRect().top;
		await onreposition({
			change: () => { choice = rowMode === "ticker" ? "all" : "ticker"; },
			top: () => row && before !== undefined && mode === "shown" && !pending ? anchorTop(row, before) : null,
		});
	}

	// Safari only paints :active when a touch listener covers the target.
	function enableTouchActive(node: HTMLDivElement) {
		return { destroy: on(node, "touchstart", () => {}, { passive: true }) };
	}
</script>

{#if logMounted || mode === "shown"}
	<div bind:this={logEl} class={className} use:enableTouchActive role="region" aria-label={`Turn log, ${stepCount} ${stepCount === 1 ? "step" : "steps"}`} hidden={mode !== "shown"} data-testid={phase !== "settled" ? "turn-live-activity" : undefined}>
		{#if phase !== "settled" && earlierCount > 0}
			<Button variant="ghost" size="content" tone="secondary" hoverFill="none" align="start" touchTarget
				class="px-[6px] py-[7px] text-[12px]" aria-expanded={rowMode === "all"} onclick={toggleEarlier}>{rowMode === "ticker" ? `+ ${plural(earlierCount, "earlier step")}` : "Hide earlier steps"}</Button>
		{/if}
		{#each visibleEntries as entry (entry.uuid)}
			<div hidden={rowMode === "ticker" && entry.index < earlierIndex}>{@render row(entry)}</div>
		{/each}
	</div>
{/if}

<style>
	[role="region"] :global(::selection) { background:var(--color-accent-bg); color:inherit; }
</style>
