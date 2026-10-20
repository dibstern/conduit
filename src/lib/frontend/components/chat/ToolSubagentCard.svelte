<!-- Renders Task/subagent tool calls with agent info and session navigation. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { selection } from "../../stores/selection.svelte.js";
	import { subagentSessionId as findSubagentSessionId } from "../../utils/subagent-tools.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { fmtDuration, toolVerb } from "../../utils/turns.js";

	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";
	import Badge from "../ui/Badge.svelte";
	import BlockGrid from '../ui/BlockGrid.svelte';

	let { message }: {
		message: ToolMessage;
	} = $props();

	function readTaskInput(input: unknown): {
		description: string;
		subagentType: string;
		prompt: string;
		taskId?: string;
	} | null {
		if (!input || typeof input !== "object") return null;
		let record = input as Record<string, unknown>;
		if (
			record["tool"] === "Unknown" &&
			record["name"] === "Agent" &&
			record["raw"] &&
			typeof record["raw"] === "object" &&
			!Array.isArray(record["raw"])
		) {
			record = record["raw"] as Record<string, unknown>;
		}
		let subagentType = "general";
		if (typeof record["subagentType"] === "string") {
			subagentType = record["subagentType"];
		} else if (typeof record["subagent_type"] === "string") {
			subagentType = record["subagent_type"];
		}
		let taskId: string | undefined;
		if (typeof record["taskId"] === "string") taskId = record["taskId"];
		else if (typeof record["task_id"] === "string") taskId = record["task_id"];
		const task = {
			description:
				typeof record["description"] === "string"
					? record["description"]
					: "",
			subagentType,
			prompt: typeof record["prompt"] === "string" ? record["prompt"] : "",
		};
		if (taskId !== undefined) return { ...task, taskId };
		return task;
	}

	const taskInput = $derived(readTaskInput(message.input));

	const subagentSessionId = $derived(findSubagentSessionId(message));
	const running = $derived(message.status === "running" || message.status === "pending");
	const duration = $derived(message.createdAt === undefined || (!running && message.endedAt === undefined) ? undefined : Math.max(0, (message.endedAt ?? clock.now) - message.createdAt));

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
			selection.open(subagentSessionId);
		}
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
</script>

<div class="min-w-0">
	<Button
		variant="ghost"
		size="transcript"
		layout="flow"
		tone="inherit"
		hoverFill="surface"
		disabledStyle="undimmed"
		align="start"
		class="subagent-header text-text-secondary select-none"
		onclick={navigateToSubagent}
		disabled={!subagentSessionId}
		title={subagentSessionId ? "Open subagent session" : undefined}
	>
		<span class="tool-status-icon shrink-0 text-text-dimmer"><Icon name="git-fork" size={14} /></span>
		<span class="shrink-0 font-semibold">{toolVerb(message, running ? "present" : "past")}</span>
		<Badge variant="tag" size="sm" class="agent-title shrink-0 font-mono capitalize select-text">{agentLabel}</Badge>
		<span class="subagent-link flex-1 min-w-0 truncate font-mono text-[12.5px] select-text">{agentDescription}</span>
		{#if duration !== undefined}<time class="ml-auto shrink-0 font-mono text-[12px] text-text-dimmer">{fmtDuration(duration)}</time>{/if}
		{#if running}<BlockGrid cols={4} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
		{:else if message.status === "error" || message.isError}<span class="shrink-0 text-error"><Icon name="circle-alert" size={12} /></span>{/if}

		<!-- Navigate arrow (only when session is available) -->
		{#if subagentSessionId}
			<span class="shrink-0 text-text-dimmer">
				<Icon name="arrow-right" size={14} />
			</span>
		{/if}
	</Button>
	{#if typeof message.metadata?.['subagentModel'] === "string" || typeof message.metadata?.['subagentMode'] === "string"}
		<div class="subagent-details pb-[3px] pl-[22px] text-[12px] text-text-muted break-words">
			{[message.metadata?.['subagentModel'], message.metadata?.['subagentMode']].filter((value) => typeof value === "string").join(" · ")}
		</div>
	{/if}

	{#if message.status !== "completed"}
	<div
		class="tool-subtitle pb-[3px] pl-[22px] text-[12px] text-text-dimmer"
	>
		<span class="tool-subtitle-text">{subtitleText}</span>
	</div>
	{/if}
</div>
