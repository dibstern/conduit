<!-- ─── User Message ────────────────────────────────────────────────────────── -->
<!-- Right-aligned user chat bubble with text. Preserves .msg-user class.
     When queued, the bubble is dimmed and shows a shimmering "Queued" label. -->

<script lang="ts">
	import type { UserMessage } from "../../types.js";
	import { escapeHtml, extractDisplayText } from "../../utils/format.js";

	let { message }: { message: UserMessage } = $props();
</script>

<div
	class="msg-user flex justify-end max-w-[760px] mx-auto mb-4 px-5"
	class:opacity-50={message.queued}
	data-uuid={message.uuid}
>
	<div class="relative max-w-[85%] max-md:max-w-[90%]">
		<div
			class="bubble bg-user-bubble rounded-[20px_20px_4px_20px] py-3 px-[18px] text-[14px] leading-[1.55] break-words whitespace-pre-wrap text-text"
			class:border={message.queued}
			class:border-dashed={message.queued}
			class:border-border={message.queued}
		>
			{@html escapeHtml(extractDisplayText(message.text))}
		</div>
		{#if message.queued}
			<div class="flex items-center justify-end mt-1 pr-1">
				<span class="queued-shimmer text-text-muted text-xs font-sans">Queued</span>
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
