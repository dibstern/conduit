<script lang="ts">
	import type { CompactionPart } from "../../utils/turns.js";
	import { fmtTokens } from "../../utils/turns.js";
	import Icon from "../ui/Icon.svelte";

	let { part, highlight = false }: {
		/** Absent while the compaction is still running. */
		part?: CompactionPart;
		highlight?: boolean;
	} = $props();
	const live = $derived(part === undefined);
</script>

<!-- One box for the running and completed compaction, so one can settle into
     the other in place. -->
<div
	class="compaction-rule flex items-center gap-[8px] py-[6px] text-[12px] text-text-dimmer {highlight ? 'bg-selection' : ''}"
	data-part={part?.uuid}
	data-testid={live ? "turn-opening-compacting" : undefined}
>
	<span class="h-px flex-1 bg-border" aria-hidden="true"></span>
	<span class="shrink-0 [&_.lucide]:w-3 [&_.lucide]:h-3" aria-hidden="true"><Icon name={live ? "loader-circle" : "minimize"} size={12} class={live ? "motion-safe:animate-spin" : ""} /></span>
	<span class="shrink-0">{live ? "Compacting context" : "Compacted context"}</span>
	{#if part?.preTokens !== undefined && part.postTokens !== undefined}
		<span class="shrink-0 font-mono text-text-dimmer">{fmtTokens(part.preTokens)} → {fmtTokens(part.postTokens)}</span>
		{#if part.preTokens > part.postTokens}
			<span class="shrink-0 text-text-dimmer">·</span>
			<span class="shrink-0 font-medium text-text-secondary">{fmtTokens(part.preTokens - part.postTokens)} saved</span>
		{/if}
	{/if}
	<span class="h-px flex-1 bg-border" aria-hidden="true"></span>
</div>
