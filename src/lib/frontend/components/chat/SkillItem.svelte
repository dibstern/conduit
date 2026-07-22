<!-- ─── Skill Item ──────────────────────────────────────────────────────────── -->
<!-- Displays a Skill tool invocation with sparkles icon, formatted name, -->
<!-- and expandable result. Dedicated component — Skills are never grouped. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import Icon from "../shared/Icon.svelte";
	import BlockGrid from '../shared/BlockGrid.svelte';

	let { message }: { message: ToolMessage } = $props();
	let expanded = $state(false);

	// ─── Skill name parsing ──────────────────────────────────────────────
	const skillName = $derived.by(() => {
		const inp = message.input as Record<string, unknown> | null | undefined;
		const inputName =
			inp?.["name"] ?? inp?.["skill"] ?? inp?.["skill_name"] ?? inp?.["skillName"];
		if (typeof inputName === "string" && inputName.length > 0) return inputName;
		// Historical sessions persisted before input normalization was fixed:
		// recover the name from the result (OpenCode wraps it in <skill_content>,
		// Claude replies "Launching skill: <name>").
		const match = message.result?.match(
			/^<skill_content\b[^>]*(?:name|skill_name)=["']([^"']+)["']|^Launching skill: (\S+)/,
		);
		return match?.[1] ?? match?.[2] ?? null;
	});

	/** Format the skill name for display: kebab-case → Title Case */
	const skillDisplayName = $derived.by(() => {
		if (!skillName) return "Skill";
		return skillName
			.split("-")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ");
	});

	// ─── Status ─────────────────────────────────────────────────────────
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

	function handleToggle() {
		expanded = !expanded;
	}
</script>

<div
	class="skill-item max-w-[760px] mx-auto px-5 my-1.5"
	data-tool-id={message.id}
>
	<div class="{message.status === 'completed' ? '' : 'bg-bg-surface'} rounded-[10px] {message.status === 'error' ? 'glow-tool-error' : message.status === 'completed' ? 'glow-brand-b' : message.status === 'running' ? 'glow-tool-running' : ''}">
		<button
			class="skill-header flex items-center gap-2.5 w-full py-2 px-3 cursor-pointer select-text text-xs text-text-dimmer hover:bg-bg-surface transition-colors duration-150 border-none text-left rounded-t-[10px]"
			onclick={handleToggle}
		>
			<!-- Status icon -->
			{#if message.status === 'running'}
				<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0 self-center" />
			{:else}
				<span class="tool-status-icon shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}">
					<Icon name={statusIconName} size={14} />
				</span>
			{/if}

			<!-- Skill icon -->
			<span class="text-text-dimmer [&_.lucide]:w-4 [&_.lucide]:h-4">
				<Icon name="sparkles" size={16} />
			</span>

			<!-- Skill label -->
			<div class="flex-1 min-w-0">
				<span class="skill-title text-text-dimmer font-medium select-text">
					{skillDisplayName}
				</span>
				{#if skillName}
					<span class="text-text-dimmer font-mono text-xs ml-1.5 select-text">
						{skillName}
					</span>
				{/if}
			</div>
		</button>

		<!-- Subtitle row (hidden when completed, like ThinkingBlock) -->
		{#if message.status !== 'completed'}
		<div
			class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer"
		>
			<span class="tool-connector font-mono not-italic text-border">└</span>
			<span class="tool-subtitle-text">{subtitleText}</span>
		</div>
		{/if}

		{#if expanded && message.result}
			<div
				class="tool-result font-mono text-xs whitespace-pre-wrap break-all my-0.5 mx-2.5 py-2 px-2.5 bg-code-bg border border-border-subtle rounded-lg text-text-secondary max-h-[300px] overflow-y-auto select-text"
			>
				{message.result.replace(/^<skill_content[^>]*>\n?/, "").replace(/\n?<\/skill_content>\s*$/, "")}
			</div>
		{/if}
	</div>
</div>
