<!-- ─── User Message ────────────────────────────────────────────────────────── -->
<!-- Left-aligned user message card with pink glow. Preserves .msg-user class.
     When queued, the card is dimmed and shows a shimmering "Queued" label. -->

<script lang="ts">
	import type { UserMessage } from "../../types.js";
	import { escapeHtml, extractDisplayText } from "../../utils/format.js";

	let { message }: { message: UserMessage } = $props();
</script>

<div
	class="msg-user max-w-[760px] mx-auto mb-3 px-5"
	class:opacity-50={message.queued}
	data-uuid={message.uuid}
>
	<div
		class="bg-bg-surface rounded-[10px] py-4 px-5 relative glow-brand-a"
		class:border={message.queued}
		class:border-dashed={message.queued}
		class:border-border={message.queued}
	>
		<div class="text-sm font-mono font-semibold uppercase tracking-[1.5px] text-brand-a mb-2">You</div>
		<div class="text-base leading-[1.7] break-words whitespace-pre-wrap text-text">
			{@html escapeHtml(extractDisplayText(message.text))}
		</div>
		{#if message.queued}
			<div class="flex items-center mt-2">
				<span class="queued-shimmer text-text-muted text-xs font-mono">Queued</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.queued-shimmer {
		background: linear-gradient(
			90deg,
			var(--color-text-muted) 0%,
			var(--color-text-secondary, #888) 50%,
			var(--color-text-muted) 100%
		);
		background-size: 200% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		animation: shimmer 2s ease-in-out infinite;
	}

	@keyframes shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}
</style>
