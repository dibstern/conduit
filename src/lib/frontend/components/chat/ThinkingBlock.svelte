<!-- ─── Thinking Block ──────────────────────────────────────────────────────── -->
<!-- Inline thinking stream with amber left-border accent. -->
<!-- Collapses to compact bar when done; expands on click. -->
<!-- Preserves .thinking-item / .thinking-block classes for E2E. -->

<script lang="ts">
	import type { ThinkingMessage } from "../../types.js";
	import BlockGrid from '../ui/BlockGrid.svelte';
	import Disclosure from "../ui/Disclosure.svelte";

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
		<div class="glow-brand-b bg-bg-surface/80 rounded-panel py-2 px-3">
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
		<Disclosure
			{expanded}
			onToggle={handleToggle}
			density="tight"
			class="thinking-header glow-brand-b rounded-panel"
		>
			<span class="thinking-label">{label}</span>
			{#if durationText}
				<span class="thinking-duration text-sm text-text-dimmer font-normal">
					{durationText}
				</span>
			{/if}
		</Disclosure>

		{#if expanded && message.text}
			<div
				class="thinking-content glow-brand-b rounded-panel py-2 px-3 font-mono text-base leading-[1.7] text-text-secondary whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto"
			>
				{message.text}
			</div>
		{/if}
	{/if}
</div>
