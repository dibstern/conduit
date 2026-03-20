<!-- ─── Tool Group Card ──────────────────────────────────────────────────────── -->
<!-- Collapsible card wrapping a group of tool calls. Shows a summary header -->
<!-- that expands to reveal ToolGroupItems. Collapsed by default. -->

<script lang="ts">
	import type { ToolGroup } from "../../utils/group-tools.js";
	import ToolGroupItem from "./ToolGroupItem.svelte";
	import Icon from "../shared/Icon.svelte";
	import BlockGrid from '../shared/BlockGrid.svelte';

	let { group }: { group: ToolGroup } = $props();
	let expanded = $state(false);

	// Status dot color (same as ToolItem)
	const bulletClass = $derived.by(() => {
		switch (group.status) {
			case "pending":
				return "bg-text-muted";
			case "running":
				return "bg-accent animate-[pulse-dot_1.2s_ease-in-out_infinite]";
			case "completed":
				return "bg-success";
			case "error":
				return "bg-error";
			default:
				return "bg-text-muted";
		}
	});

	// Status icon (same as ToolItem)
	const statusIconName = $derived.by(() => {
		switch (group.status) {
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
		if (group.status === "running" || group.status === "pending")
			return "text-text-muted";
		if (group.status === "error") return "text-error";
		return "text-text-dimmer";
	});

	function handleToggle() {
		expanded = !expanded;
	}
</script>

<div class="max-w-[760px] mx-auto px-5 my-1.5">
	<div class="bg-bg-surface rounded-[10px] relative overflow-hidden {group.status === 'error' ? 'glow-tool-error' : group.status === 'completed' ? 'glow-tool-completed' : group.status === 'running' ? 'glow-tool-running' : ''}">
		{#if group.status === 'running'}
			<div class="absolute inset-0 pointer-events-none rounded-[10px]" style="background: linear-gradient(90deg, transparent 0%, rgba(234,179,8,0.04) 50%, transparent 100%); animation: tool-shimmer-slide 2s ease-in-out infinite;"></div>
		{/if}
		<!-- Header button -->
		<button
			class="flex items-center gap-2.5 w-full py-2 px-3 cursor-pointer select-none text-[13px] text-text-secondary hover:bg-[rgba(var(--overlay-rgb),0.03)] transition-colors duration-150 border-none text-left"
			onclick={handleToggle}
		>
			<span
				class="text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"
				class:rotate-90={expanded}
			>
				<Icon name="chevron-right" size={14} />
			</span>

			<span class="w-2 h-2 rounded-full shrink-0 {bulletClass}"></span>

		{#if group.status === 'running'}
			<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0 self-center" />
		{:else}
			<span class="shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}">
				<Icon name={statusIconName} size={14} />
			</span>
		{/if}

			<span class="font-medium font-mono text-text-secondary">
				{group.label}
			</span>

			<span class="text-text-dimmer font-mono text-xs">
				· {group.summary}
			</span>

			<span class="flex-1"></span>
		</button>

		<!-- Expanded tool list -->
		{#if expanded}
			<div class="pb-1">
				{#each group.tools as tool, i (tool.id)}
					<ToolGroupItem
						message={tool}
						isLast={i === group.tools.length - 1}
					/>
				{/each}
			</div>
		{/if}
	</div>
</div>
