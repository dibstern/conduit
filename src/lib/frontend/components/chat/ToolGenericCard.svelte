<!-- ─── Tool Generic Card ─────────────────────────────────────────────────── -->
<!-- Renders all non-question, non-subagent tool calls with expand/collapse, -->
<!-- result preview, and truncation handling. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { TOOL_CONTENT_LOAD_TIMEOUT_MS } from "../../ui-constants.js";
	import { extractToolSummary } from "../../utils/group-tools.js";
	import { wsSend } from "../../stores/ws.svelte.js";

	import Icon from "../shared/Icon.svelte";
	import BlockGrid from '../shared/BlockGrid.svelte';

	let { message, groupRadius }: {
		message: ToolMessage;
		groupRadius: string;
	} = $props();

	// ─── Local state ────────────────────────────────────────────────────────

	let expanded = $state(false);
	let loadingFullContent = $state(false);
	let loadingTimeout: ReturnType<typeof setTimeout> | undefined;

	function formatKB(length: number): string {
		return `${(length / 1024).toFixed(1)} KB`;
	}

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

	function handleToggle() {
		expanded = !expanded;
	}

	// ─── Status display ─────────────────────────────────────────────────────

	const statusIconName = $derived.by(() => {
		switch (message.status) {
			case "running":
			case "pending":
				return "loader";
			case "completed":
				return "check";
			case "error":
				return "circle-alert";
			default:
				return "loader";
		}
	});

	const statusIconClass = $derived.by(() => {
		if (message.status === "running" || message.status === "pending")
			return "text-text-muted";
		if (message.status === "error") return "text-error";
		return "text-text-dimmer";
	});

	const subtitleText = $derived.by(() => {
		switch (message.status) {
			case "pending":
				return "Pending…";
			case "running":
				return "Running…";
			case "completed":
				return "Done";
			case "error":
				return "Error";
			default:
				return "";
		}
	});

	const resultErrorClass = $derived(
		message.isError ? "border-error/30 text-error" : "",
	);

	// Tool input summary (subtitle + tags)
	const toolSummary = $derived(extractToolSummary(message.name, message.input as Record<string, unknown> | undefined));

	// For Bash/Shell tools, extract the raw command for display in expanded view
	const bashCommand = $derived.by(() => {
		if (message.name !== "Bash") return null;
		const inp = message.input as Record<string, unknown> | null | undefined;
		if (!inp) return null;
		const cmd = inp['command'] as string | undefined;
		return cmd ?? null;
	});

	// Description preview (prefer input subtitle, then first line of result, then status)
	const descText = $derived.by(() => {
		if (toolSummary.subtitle) return toolSummary.subtitle;
		if (message.result) {
			const firstLine = message.result.split("\n")[0] ?? "";
			return firstLine.length > 60
				? `${firstLine.slice(0, 60)}…`
				: firstLine;
		}
		if (message.status === "running") return "Running…";
		return "";
	});
</script>

<div class="{message.status === 'completed' ? '' : 'bg-bg-surface'} {groupRadius} relative overflow-hidden {message.status === 'error' ? 'glow-tool-error' : message.status === 'completed' ? 'glow-brand-b' : message.status === 'running' ? 'glow-tool-running' : ''}">
	{#if message.status === 'running'}
		<div class="absolute inset-0 pointer-events-none" style="background: linear-gradient(90deg, transparent 0%, rgba(234,179,8,0.04) 50%, transparent 100%); animation: tool-shimmer-slide 2s ease-in-out infinite;"></div>
	{/if}
	<button
		class="tool-header flex items-center gap-2.5 w-full py-2 px-3 cursor-pointer select-none text-xs text-text-dimmer hover:bg-bg-surface transition-colors duration-150 border-none text-left"
		onclick={handleToggle}
	>
	<span
		class="tool-chevron text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"
		class:rotate-90={expanded}
	>
		<Icon name="chevron-right" size={14} />
	</span>

	{#if message.status === 'running'}
		<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0 self-center" />
	{:else}
		<span class="tool-status-icon shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}">
			<Icon name={statusIconName} size={14} />
		</span>
	{/if}

	<span class="tool-name font-medium text-text-dimmer">
		{message.name}
	</span>

	<span
		class="tool-desc flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-dimmer"
	>
		{descText}
	</span>

	{#if toolSummary.tags}
		{#each toolSummary.tags as tag}
			<span class="px-1.5 py-0.5 rounded bg-[rgba(var(--overlay-rgb),0.05)] font-mono text-sm text-text-dimmer shrink-0">
				{tag}
			</span>
		{/each}
	{/if}
	</button>

	{#if message.status !== 'completed'}
	<div
		class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer"
	>
		<span class="tool-connector font-mono not-italic text-border">└</span>
		<span class="tool-subtitle-text">{subtitleText}</span>
	</div>
	{/if}

	{#if expanded && (message.result || bashCommand)}
		<div
			class="tool-result font-mono text-xs whitespace-pre-wrap break-all my-0.5 mx-2.5 py-3 px-4 bg-code-bg border border-border-subtle rounded-lg text-text-secondary max-h-[200px] overflow-y-auto {resultErrorClass}"
			class:is-error={message.isError}
		>
			{#if bashCommand}<span class="text-text-muted">$ {bashCommand}</span>{#if message.result}{"\n\n"}{/if}{/if}{#if message.result}{message.result}{/if}
		</div>

		{#if message.isTruncated && message.result}
			<div class="flex items-center gap-2 mx-2.5 mt-1 mb-1 text-xs text-text-dimmer">
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
	{/if}
</div>
