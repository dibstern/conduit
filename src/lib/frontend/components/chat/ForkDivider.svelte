<!-- Fork Divider -->
<!-- Horizontal rule with centered label showing the fork origin. -->
<!-- Clicking the Source title navigates to the Source session. A Fork whose -->
<!-- Source was deleted has no lineage, so it names no Source and links nowhere. -->

<script lang="ts">
	import Button from "../ui/Button.svelte";
	import { selection } from "../../stores/selection.svelte.js";

	interface Props {
		sourceTitle: string;
		sourceId?: string | undefined;
	}

	let { sourceTitle, sourceId }: Props = $props();
</script>

<div class="fork-divider flex items-center gap-3 my-4 max-w-[760px] mx-auto px-5">
	<div class="flex-1 h-px bg-border"></div>
	<span class="text-[11px] text-text-dimmer font-mono whitespace-nowrap">
		{#if sourceId}
			Forked from
			<Button
				variant="ghost"
				size="content"
				layout="flow"
				tone="muted-soft"
				hoverFill="none"
				type="button"
				class="underline decoration-dotted p-0 font-mono text-[11px]"
				onclick={() => selection.open(sourceId)}
				title="Go to source session"
			>
				{sourceTitle}
			</Button>
		{:else}
			Forked from a deleted session
		{/if}
	</span>
	<div class="flex-1 h-px bg-border"></div>
</div>
