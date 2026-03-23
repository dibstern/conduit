<!-- ─── Thinking Block ──────────────────────────────────────────────────────── -->
<!-- Inline thinking stream with amber left-border accent. -->
<!-- Collapses to compact bar when done; expands on click. -->
<!-- Preserves .thinking-item / .thinking-block classes for E2E. -->

<script lang="ts">
	import type { ThinkingMessage } from "../../types.js";
	import Icon from "../shared/Icon.svelte";
	import BlockGrid from '../shared/BlockGrid.svelte';

	let { message }: { message: ThinkingMessage } = $props();
	let expanded = $state(false);

	// Random thinking verb (assigned once per block)
	const thinkingVerbs = [
		"Contemplating", "Architecting", "Brewing", "Calibrating", "Channeling",
		"Composing", "Computing", "Conjuring", "Constructing", "Crafting",
		"Crystallizing", "Debugging", "Deciphering", "Designing", "Distilling",
		"Drafting", "Engineering", "Evaluating", "Evolving", "Exploring",
		"Fabricating", "Formulating", "Generating", "Ideating", "Imagining",
		"Innovating", "Integrating", "Iterating", "Manifesting", "Mapping",
		"Materializing", "Modeling", "Navigating", "Optimizing", "Orchestrating",
		"Parsing", "Pondering", "Processing", "Projecting", "Prototyping",
		"Reasoning", "Refining", "Resolving", "Sculpting", "Shaping",
		"Simulating", "Sketching", "Solving", "Strategizing", "Structuring",
		"Synthesizing", "Theorizing", "Thinking", "Transforming", "Unraveling",
		"Visualizing", "Weaving",
	];
	const verb = thinkingVerbs[Math.floor(Math.random() * thinkingVerbs.length)];

	const label = $derived(message.done ? "Thought" : verb);
	const durationText = $derived(
		message.duration !== undefined
			? `${(message.duration / 1000).toFixed(1)}s`
			: "",
	);

	function handleToggle() {
		expanded = !expanded;
	}

	// Auto-collapse when thinking completes
	$effect(() => {
		if (message.done) {
			expanded = false;
		}
	});
</script>

<div
	class="thinking-block thinking-item max-w-[760px] mx-auto my-1.5 px-5"
	class:expanded
	class:done={message.done}
>
	{#if !message.done}
		<!-- Streaming: inline thinking display -->
		<div class="glow-brand-b bg-bg-surface/80 rounded-[10px] py-2 px-3">
			<div class="flex items-center gap-1.5 mb-1.5">
				<BlockGrid cols={5} mode="fast" blockSize={2} gap={0.75} class="self-center" />
				<span class="text-xs text-brand-b font-medium">{label}…</span>
			</div>
			{#if message.text}
				<div class="font-mono text-base leading-[1.55] text-text-secondary whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
					{message.text}
				</div>
			{/if}
		</div>
	{:else}
		<!-- Done: compact collapsible bar -->
		<button
			class="thinking-header flex items-center gap-1.5 cursor-pointer py-2 px-3 select-none glow-brand-b rounded-[10px] text-xs text-text-dimmer hover:bg-bg-surface transition-colors duration-150 w-full text-left"
			onclick={handleToggle}
		>
			<span
				class="thinking-chevron text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"
				class:rotate-90={expanded}
			>
				<Icon name="chevron-right" size={14} />
			</span>

			<span class="thinking-label">{label}</span>
			{#if durationText}
				<span class="thinking-duration text-sm text-text-dimmer font-normal">
					{durationText}
				</span>
			{/if}
		</button>

		{#if expanded && message.text}
			<div
				class="thinking-content glow-brand-b rounded-[10px] py-2 px-3 font-mono text-base leading-[1.7] text-text-secondary whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto"
			>
				{message.text}
			</div>
		{/if}
	{/if}
</div>
