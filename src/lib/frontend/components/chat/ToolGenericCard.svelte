<!-- Renders all non-question, non-subagent tool calls with expand/collapse, -->
<!-- result preview, and the full detail of a previewed tool. -->

<script lang="ts">
	import type { ComponentProps } from "svelte";
	import type { ToolMessage } from "../../types.js";
	import { lookupSummarizer } from "../../utils/tool-summarizers/index.js";
	import { ensureCanonical } from "../../utils/tool-summarizers/ensure-canonical.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { fmtDuration, toolCommand, toolVerb } from "../../utils/turns.js";
	import { toolStyle } from "./activity-style.js";

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
	const running = $derived(message.status === "running" || message.status === "pending");
	const duration = $derived(message.createdAt === undefined || (!running && message.endedAt === undefined) ? undefined : Math.max(0, (message.endedAt ?? clock.now) - message.createdAt));
	const icon = $derived(toolStyle(message).icon);

	function handleToggle() {
		expanded = !expanded;
	}

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

	const resultErrorClass = $derived(message.isError ? "text-error" : "text-text-secondary");

	// Tool input summary (subtitle + tags)
	const toolSummary = $derived(
		lookupSummarizer(message.name).summarize(
			ensureCanonical(message.name, message.input),
			{},
		),
	);

	const bashCommand = $derived(toolCommand(message));
	const movedToBackground = $derived(message.metadata?.['movedToBackground'] === true);
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

<div class="min-w-0">
	<!-- `tool-header` is load-bearing: test/visual/tool-item.spec.ts clicks it. -->
	<Disclosure look="transcript" density="transcript" selectable chevron={false}
		{expanded} onToggle={handleToggle} class="tool-header">
	<span class="tool-status-icon shrink-0 text-text-dimmer"><Icon name={icon} size={14} /></span>

	<span class="tool-name shrink-0 text-[12.5px] font-normal text-text-muted select-text">
		{toolVerb(message, running ? "present" : "past")}
	</span>

	<span
		class="tool-desc flex-1 min-w-0 truncate font-mono text-mono-code text-text-dimmer select-text"
	>
		{descText}
	</span>
	{#if typeof message.metadata?.['cursorToolType'] === "string" && message.metadata['truncated'] === true}<span class="shrink-0 text-[12px] text-text-muted">Truncated</span>{/if}
	{#if movedToBackground}<span class="shrink-0 text-[12px] text-text-muted">Moved to background</span>{/if}

	{#if toolSummary.tags}
		{#each toolSummary.tags as tag}
			<Badge variant="tag" size="sm" class="font-mono select-text">{tag}</Badge>
		{/each}
	{/if}
	{#if duration !== undefined}<time class="ml-auto shrink-0 font-mono text-mono-time text-text-dimmer">{fmtDuration(duration)}</time>{/if}
	{#if running}<BlockGrid cols={4} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
	{:else if message.status === "error" || message.isError}<span class="shrink-0 text-error"><Icon name="circle-alert" size={12} /></span>{/if}
	</Disclosure>

	{#if message.status !== 'completed'}
	<div
		class="tool-subtitle flex items-center gap-[6px] pb-[3px] pl-[22px] text-[12px] text-text-dimmer"
	>
		<span class="tool-subtitle-text">{subtitleText}</span>
	</div>
	{/if}

	{#if expanded && (message.result || bashCommand || cursorDetail)}
		<ToolFullDetail {message} {...loadDetails && { load: loadDetails }} class="ml-[22px] mr-[4px] mt-1 mb-1">
			{#snippet children(tool)}
				{@const command = toolCommand(tool)}
				<Surface
					variant="bare"
					padding="md"
					radius="md"
					class="tool-result bg-code-bg font-mono text-mono-xs leading-[1.6] whitespace-pre-wrap break-all my-[4px] max-h-[200px] overflow-y-auto select-text {resultErrorClass}"
				>
					{#if command}<span class="text-text-muted">$ {command}</span>{#if tool.result}{"\n\n"}{/if}{/if}{#if tool.result}{tool.result}{/if}
				</Surface>
			{/snippet}
		</ToolFullDetail>
	{/if}
</div>
