<!-- ─── Step Header ───────────────────────────────────────────────────────── -->
<!-- Reusable step counter + title + description used by each setup step.    -->

<script lang="ts">
	let {
		totalSteps,
		currentIdx,
		title,
		description,
	}: {
		totalSteps: number;
		currentIdx: number;
		title: string;
		description: string;
	} = $props();
</script>

{#if totalSteps > 1}
	<div
		class="text-sm uppercase tracking-[1px] text-text font-semibold mb-2"
	>
		Step {currentIdx + 1} of {totalSteps}
	</div>
{/if}
<div class="text-lg font-semibold mb-1.5">{title}</div>
<div class="text-sm leading-relaxed text-text-muted mb-5">{description}</div>
