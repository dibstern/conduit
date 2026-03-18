<!-- ─── Tool Group Card ──────────────────────────────────────────────────────── -->
<!-- Collapsible card wrapping a group of tool calls. Shows a summary header -->
<!-- that expands to reveal ToolGroupItems. Collapsed by default. -->

<script lang="ts">
	import type { ToolGroup } from "../../utils/group-tools.js";
	import ToolGroupItem from "./ToolGroupItem.svelte";
	import Icon from "../shared/Icon.svelte";

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
			return "text-text-muted icon-spin";
		if (group.status === "error") return "text-error";
		return "text-text-dimmer";
	});

	const borderColor = $derived(
		group.status === "error" ? "border-error" : "border-tool",
	);

	function handleToggle() {
		expanded = !expanded;
	}
</script>

<div class="max-w-[760px] mx-auto px-5 my-1.5">
	<div class="border-l-3 {borderColor} bg-tool-bg rounded-r-lg">
		<!-- Header button -->
		<button
			class="flex items-center gap-2.5 w-full py-2 px-3 cursor-pointer select-none text-[13px] text-text-secondary hover:bg-[rgba(var(--overlay-rgb),0.03)] transition-colors duration-150 border-none text-left rounded-tr-lg"
			onclick={handleToggle}
		>
			<span
				class="text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"
				class:rotate-90={expanded}
			>
				<Icon name="chevron-right" size={14} />
			</span>

			<span class="w-2 h-2 rounded-full shrink-0 {bulletClass}"></span>

			<span class="font-medium text-text-secondary">
				{group.label}
			</span>

			<span class="text-text-dimmer font-mono text-xs">
				· {group.summary}
			</span>

			<span class="flex-1"></span>

			<span
				class="shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}"
			>
				<Icon name={statusIconName} size={14} />
			</span>
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
