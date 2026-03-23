<!-- ─── Tool Group Item ──────────────────────────────────────────────────────── -->
<!-- Compact row within a ToolGroupCard. Shows tree connector, tool name, -->
<!-- subtitle, tags, and status dot. Clickable to inline-expand the result. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { TOOL_CONTENT_LOAD_TIMEOUT_MS } from "../../ui-constants.js";
	import { extractToolSummary } from "../../utils/group-tools.js";
	import { wsSend } from "../../stores/ws.svelte.js";

	let { message, isLast = false }: { message: ToolMessage; isLast?: boolean } = $props();
	let expanded = $state(false);
	let loadingFullContent = $state(false);

	const summary = $derived(extractToolSummary(message.name, message.input));

	// For Bash/Shell tools, extract the raw command for display in expanded view
	const bashCommand = $derived.by(() => {
		if (message.name !== "Bash") return null;
		const inp = message.input as Record<string, unknown> | null | undefined;
		if (!inp) return null;
		const cmd = inp.command as string | undefined;
		return cmd ?? null;
	});

	function formatKB(length: number): string {
		return `${(length / 1024).toFixed(1)} KB`;
	}

	function handleToggle() {
		expanded = !expanded;
	}

	let loadingTimeout: ReturnType<typeof setTimeout> | undefined;

	function requestFullContent() {
		loadingFullContent = true;
		wsSend({ type: "get_tool_content", toolId: message.id });
		clearTimeout(loadingTimeout);
		loadingTimeout = setTimeout(() => {
			loadingFullContent = false;
		}, TOOL_CONTENT_LOAD_TIMEOUT_MS);
	}

	$effect(() => {
		if (!message.isTruncated) {
			loadingFullContent = false;
			clearTimeout(loadingTimeout);
		}
	});

	// Error styling for result (Tailwind classes with / can't use class: directive)
	const resultErrorClass = $derived(
		message.isError ? "border-error/30 text-error" : "",
	);
</script>

<div class="tool-group-item" data-tool-id={message.id}>
	<!-- Compact row -->
	<button
		class="flex items-center gap-2 w-full py-1 px-3 cursor-pointer select-none text-xs text-text-dimmer hover:bg-bg-surface transition-colors duration-150 border-none text-left"
		onclick={handleToggle}
	>
		<!-- Tree connector -->
		<span class="font-mono text-border text-xs shrink-0 w-3 text-center">
			{isLast ? "└" : "├"}
		</span>

		<!-- Tool name -->
		<span class="text-text-dimmer font-medium shrink-0">
			{message.name}
		</span>

		<!-- Subtitle -->
		{#if summary.subtitle}
			<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-dimmer">
				{summary.subtitle}
			</span>
		{:else}
			<span class="flex-1"></span>
		{/if}

		<!-- Tags -->
		{#if summary.tags}
			{#each summary.tags as tag}
				<span class="px-1.5 py-0.5 rounded bg-[rgba(var(--overlay-rgb),0.05)] font-mono text-sm text-text-dimmer shrink-0">
					{tag}
				</span>
			{/each}
		{/if}


	</button>

	<!-- Expanded result -->
	{#if expanded && (message.result || bashCommand)}
		<div class="ml-8 mr-2.5">
			<div
				class="tool-result font-mono text-xs whitespace-pre-wrap break-all my-0.5 py-2 px-2.5 bg-code-bg border border-border-subtle rounded-lg text-text-secondary max-h-[300px] overflow-y-auto {resultErrorClass}"
				class:is-error={message.isError}
			>
				{#if bashCommand}<span class="text-text-muted">$ {bashCommand}</span>{#if message.result}{"\n\n"}{/if}{/if}{#if message.result}{message.result}{/if}
			</div>

			{#if message.isTruncated && message.result}
				<div class="flex items-center gap-2 mt-1 mb-1 text-xs text-text-dimmer">
					<span class="font-mono">
						Showing {formatKB(message.result.length)} of {formatKB(message.fullContentLength ?? message.result.length)}
					</span>
					<button
						class="px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors duration-150 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
						onclick={requestFullContent}
						disabled={loadingFullContent}
					>
						{#if loadingFullContent}
							Loading…
						{:else}
							Show full output
						{/if}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>
