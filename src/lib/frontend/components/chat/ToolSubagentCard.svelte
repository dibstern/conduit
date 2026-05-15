<!-- ─── Tool Subagent Card ────────────────────────────────────────────────── -->
<!-- Renders Task/subagent tool calls with agent info and session navigation. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { switchToSession } from "../../stores/session.svelte.js";

	import Icon from "../shared/Icon.svelte";
	import BlockGrid from '../shared/BlockGrid.svelte';

	let { message, groupRadius }: {
		message: ToolMessage;
		groupRadius: string;
	} = $props();

	// ─── Subagent detection ─────────────────────────────────────────────────
	// The task tool name is "Task" (mapped) or "task" (raw). Input contains
	// description, subagent_type, prompt, and optionally task_id.
	// The result contains "task_id: <session_id>" on the first line.

	const taskInput = $derived.by(() => {
		const inp = message.input as Record<string, unknown> | null | undefined;
		if (!inp) return null;
		return {
			description: (inp['description'] as string) ?? "",
			subagentType: (inp['subagent_type'] as string) ?? "general",
			prompt: (inp['prompt'] as string) ?? "",
			taskId: (inp['task_id'] as string) ?? undefined,
		};
	});

	/** Extract the spawned session ID from the task tool result, metadata,
	 *  or the tool input's task_id field. Each strategy correlates a specific
	 *  tool call to its session — generic session-list matching is intentionally
	 *  omitted because it cannot distinguish between multiple child sessions
	 *  and would return a stale/wrong session. */
	const subagentSessionId = $derived.by(() => {
		// 1. Input's task_id (present when resuming a previous task)
		if (taskInput?.taskId) return taskInput.taskId;
		// 2. Result text: "task_id: ses_xxxxx ..."
		if (message.result) {
			const match = message.result.match(/task_id:\s*(ses_\S+)/);
			if (match?.[1]) return match[1];
		}
		// 3. Metadata sessionId (forwarded from OpenCode's tool part state)
		const metaSessionId = (message.metadata as Record<string, unknown> | undefined)?.["sessionId"];
		if (typeof metaSessionId === "string" && metaSessionId) return metaSessionId;
		return null;
	});

	const agentLabel = $derived(
		taskInput
			? `${taskInput.subagentType} Agent`
			: "Agent"
	);

	const agentDescription = $derived(
		taskInput?.description ?? ""
	);

	function navigateToSubagent(e: MouseEvent) {
		e.stopPropagation();
		if (subagentSessionId) {
			switchToSession(subagentSessionId);
		}
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
</script>

<div class="{message.status === 'completed' ? '' : 'bg-bg-surface'} {groupRadius} relative overflow-hidden {message.status === 'error' ? 'glow-tool-error' : message.status === 'completed' ? 'glow-brand-b' : message.status === 'running' ? 'glow-tool-running' : ''}">
	{#if message.status === 'running'}
		<div class="absolute inset-0 pointer-events-none" style="background: linear-gradient(90deg, transparent 0%, rgba(234,179,8,0.04) 50%, transparent 100%); animation: tool-shimmer-slide 2s ease-in-out infinite;"></div>
	{/if}
	<button
		class="subagent-header flex items-center gap-2.5 w-full py-2.5 px-3 text-xs text-text-dimmer transition-colors duration-150 border-none text-left select-none bg-transparent disabled:opacity-100 disabled:cursor-default {subagentSessionId ? 'cursor-pointer hover:bg-bg-surface' : ''}"
		onclick={navigateToSubagent}
		disabled={!subagentSessionId}
		title={subagentSessionId ? "Open subagent session" : undefined}
	>
		<!-- Status icon -->
		{#if message.status === 'running'}
			<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0 self-center" />
		{:else}
			<span class="tool-status-icon shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}">
				<Icon name={statusIconName} size={14} />
			</span>
		{/if}

		<!-- Agent icon -->
		<span class="text-accent [&_.lucide]:w-4 [&_.lucide]:h-4">
			<Icon name="bot" size={16} />
		</span>

		<!-- Agent label + description -->
		<div class="flex-1 min-w-0">
			<span class="agent-title text-text-dimmer font-medium capitalize">
				{agentLabel}
			</span>
			{#if agentDescription}
				<span
					class="subagent-link block text-xs text-text-dimmer truncate max-w-full mt-0.5"
					class:underline={!!subagentSessionId}
					class:hover:text-accent={!!subagentSessionId}
				>
					{agentDescription}
				</span>
			{/if}
		</div>

		<!-- Navigate arrow (only when session is available) -->
		{#if subagentSessionId}
			<span class="shrink-0 text-text-dimmer">
				<Icon name="arrow-right" size={14} />
			</span>
		{/if}
	</button>

	<!-- Subtitle row -->
	<div
		class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer"
	>
		<span class="tool-connector font-mono not-italic text-border">└</span>
		<span class="tool-subtitle-text">{subtitleText}</span>
	</div>
</div>
