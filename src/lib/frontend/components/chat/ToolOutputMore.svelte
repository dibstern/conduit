<!-- "Showing 48.8 KB of 128.9 KB · Show full output" under a tool output the -->
<!-- server cut short. The rest arrives through GetToolContent on request.     -->
<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { TOOL_CONTENT_LOAD_TIMEOUT_MS } from "../../ui-constants.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { applyToolContentResponse } from "../../stores/chat.svelte.js";
	import { getToolContentRpc } from "../../transport/ws-rpc-client.js";
	import Button from "../ui/Button.svelte";

	let { message, class: className = "" }: { message: ToolMessage; class?: string } = $props();

	let loading = $state(false);

	const formatKB = (length: number) => `${(length / 1024).toFixed(1)} KB`;

	async function requestFullContent() {
		const slug = getCurrentSlug();
		if (!slug) return;
		loading = true;
		// A request that never settles must not leave the button disabled.
		const timeout = setTimeout(() => (loading = false), TOOL_CONTENT_LOAD_TIMEOUT_MS);
		try {
			applyToolContentResponse(
				await getToolContentRpc({ projectSlug: slug, toolId: message.id }),
			);
		} catch {
			// Nothing better to show than the preview; the button re-enables.
		} finally {
			loading = false;
			clearTimeout(timeout);
		}
	}
</script>

{#if message.isTruncated && message.result}
	<div class="flex items-center gap-2 text-xs text-text-dimmer {className}">
		<span class="font-mono">
			Showing {formatKB(message.result.length)} of {formatKB(message.fullContentLength ?? message.result.length)}
		</span>
		<Button
			variant="accent-soft"
			size="content"
			class="px-2 py-0.5 rounded text-xs font-medium"
			onclick={requestFullContent}
			disabled={loading}
		>
			{#if loading}
				Loading…
			{:else}
				Show full output
			{/if}
		</Button>
	</div>
{/if}
