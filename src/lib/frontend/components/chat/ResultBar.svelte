<!-- ─── Result Bar ──────────────────────────────────────────────────────────── -->
<!-- Displays cost, duration, and token usage for a completed turn. -->

<script lang="ts">
	import type { ResultMessage } from "../../types.js";

	let { message }: { message: ResultMessage } = $props();

	const displayText = $derived.by(() => {
		const parts: string[] = [];

		if (message.cost !== undefined && message.cost > 0) {
			parts.push(`$${message.cost.toFixed(4)}`);
		}
		if (message.duration !== undefined && message.duration > 0) {
			parts.push(`${(message.duration / 1000).toFixed(1)}s`);
		}
		if (message.inputTokens) {
			parts.push(`${message.inputTokens} in`);
		}
		if (message.outputTokens) {
			parts.push(`${message.outputTokens} out`);
		}
		if (message.cacheRead) {
			parts.push(`${message.cacheRead} cache`);
		}

		return parts.join(" · ");
	});
</script>

{#if displayText}
	<div class="result-bar turn-meta max-w-[760px] mx-auto mt-1 mb-5 px-5 text-xs text-text-dimmer">
		{displayText}
	</div>
{/if}
