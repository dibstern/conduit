<!-- Renders all non-question, non-subagent tool calls with expand/collapse, -->
<!-- result preview, and the full detail of a previewed tool. -->

<script lang="ts">
	import type { ComponentProps } from "svelte";
	import type { ToolMessage } from "../../types.js";
	import { lookupSummarizer } from "../../utils/tool-summarizers/index.js";
	import { ensureCanonical } from "../../utils/tool-summarizers/ensure-canonical.js";

	import Icon from "../ui/Icon.svelte";
	import Badge from "../ui/Badge.svelte";
	import Disclosure from "../ui/Disclosure.svelte";
	import BlockGrid from '../ui/BlockGrid.svelte';
	import Surface from "../ui/Surface.svelte";
	import ToolFullDetail from "./ToolFullDetail.svelte";

	let { message, loadDetails }: {
		message: ToolMessage;
		/** Stands in for the server in stories. */
		loadDetails?: ComponentProps<typeof ToolFullDetail>["load"];
	} = $props();

	let expanded = $state(false);
	const glowClass = $derived.by(() => {
		if (message.status === "error") return "glow-tool-error";
		if (message.status === "completed") return "glow-brand-b";
		if (message.status === "running") return "glow-tool-running";
		return "";
	});

	function handleToggle() {
		expanded = !expanded;
	}

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
	const toolSummary = $derived(
		lookupSummarizer(message.name).summarize(
			ensureCanonical(message.name, message.input),
			{},
		),
	);

	// For Bash/Shell tools, extract the raw command for display in expanded view
	function commandOf(tool: ToolMessage): string | null {
		if (tool.name !== "Bash") return null;
		const inp = tool.input as Record<string, unknown> | null | undefined;
		return (inp?.["command"] as string | undefined) ?? null;
	}
	const bashCommand = $derived(commandOf(message));
	const cursorDetail = $derived(typeof message.metadata?.['cursorToolType'] === "string" && (message.metadata['fileChange'] || message.metadata['plan'] || message.metadata['computerUse'] || message.metadata['media'] || message.metadata['output'] !== undefined || ensureCanonical(message.name, message.input).tool === "Unknown"));

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

<div class="{message.status === 'completed' ? '' : 'bg-bg-surface'} rounded-panel relative overflow-hidden {glowClass}">
	{#if message.status === 'running'}
		<div class="absolute inset-0 pointer-events-none" style="background: linear-gradient(90deg, transparent 0%, rgba(234,179,8,0.04) 50%, transparent 100%); animation: tool-shimmer-slide 2s ease-in-out infinite;"></div>
	{/if}
	<!-- `tool-header` is load-bearing: test/visual/tool-item.spec.ts clicks it. -->
	<Disclosure {expanded} onToggle={handleToggle} selectable class="tool-header">
	{#if message.status === 'running'}
		<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0 self-center" />
	{:else}
		<span class="tool-status-icon shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}">
			<Icon name={statusIconName} size={14} />
		</span>
	{/if}

	<span class="tool-name font-medium text-text-dimmer select-text">
		{message.name}
	</span>

	<span
		class="tool-desc flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-dimmer select-text"
	>
		{descText}
	</span>
	{#if typeof message.metadata?.['cursorToolType'] === "string" && message.metadata['truncated'] === true}<span class="text-xs text-text-muted">Truncated</span>{/if}

	{#if toolSummary.tags}
		{#each toolSummary.tags as tag}
			<Badge variant="tag" size="sm" class="font-mono select-text">{tag}</Badge>
		{/each}
	{/if}
	</Disclosure>

	{#if message.status !== 'completed'}
	<div
		class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer"
	>
		<span class="tool-connector font-mono not-italic text-border">└</span>
		<span class="tool-subtitle-text">{subtitleText}</span>
	</div>
	{/if}

	{#if expanded && (message.result || bashCommand || cursorDetail)}
		<ToolFullDetail {message} {...loadDetails && { load: loadDetails }} class="mx-2.5 mt-1 mb-1">
			{#snippet children(tool)}
				{@const command = commandOf(tool)}
				<Surface
					variant="inset"
					padding="md"
					radius="md"
					class="tool-result font-mono text-xs whitespace-pre-wrap break-all my-0.5 mx-2.5 text-text-secondary max-h-[200px] overflow-y-auto select-text {resultErrorClass}"
				>
					{#if command}<span class="text-text-muted">$ {command}</span>{#if tool.result}{"\n\n"}{/if}{/if}{#if tool.result}{tool.result}{/if}
				</Surface>
			{/snippet}
		</ToolFullDetail>
	{/if}
</div>
