<!-- ─── Skill Item ──────────────────────────────────────────────────────────── -->
<!-- Displays a Skill tool invocation with sparkles icon, formatted name, -->
<!-- and expandable result. Dedicated component — Skills are never grouped. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import Icon from "../shared/Icon.svelte";

	let { message }: { message: ToolMessage } = $props();
	let expanded = $state(false);

	// ─── Skill name parsing ──────────────────────────────────────────────
	const skillName = $derived.by(() => {
		const inp = message.input as Record<string, unknown> | null | undefined;
		return (inp?.['name'] as string) ?? null;
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
	const bulletClass = $derived.by(() => {
		switch (message.status) {
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
			return "text-text-muted icon-spin";
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

	const borderColor = $derived(
		message.isError ? "border-error" : "border-tool"
	);

	function handleToggle() {
		expanded = !expanded;
	}
</script>

<div
	class="skill-item max-w-[760px] mx-auto px-5 my-1.5"
	data-tool-id={message.id}
>
	<div class="border-l-3 {borderColor} bg-tool-bg rounded-r-lg">
		<button
			class="skill-header flex items-center gap-2.5 w-full py-2 px-3 cursor-pointer select-none text-[13px] text-text-secondary hover:bg-black/[0.03] transition-colors duration-150 border-none text-left rounded-tr-lg"
			onclick={handleToggle}
		>
			<!-- Status bullet -->
			<span class="tool-bullet w-2 h-2 rounded-full shrink-0 {bulletClass}"></span>

			<!-- Skill icon -->
			<span class="text-accent [&_.lucide]:w-4 [&_.lucide]:h-4">
				<Icon name="sparkles" size={16} />
			</span>

			<!-- Skill label -->
			<div class="flex-1 min-w-0">
				<span class="skill-title text-accent font-semibold text-xs">
					{skillDisplayName}
				</span>
				{#if skillName}
					<span class="text-text-dimmer font-mono text-xs ml-1.5">
						{skillName}
					</span>
				{/if}
			</div>

			<!-- Status icon -->
			<span
				class="tool-status-icon shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}"
			>
				<Icon name={statusIconName} size={14} />
			</span>
		</button>

		<!-- Subtitle row -->
		<div
			class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer"
		>
			<span class="tool-connector font-mono not-italic text-border">└</span>
			<span class="tool-subtitle-text">{subtitleText}</span>
		</div>

		{#if expanded && message.result}
			<div
				class="tool-result font-mono text-xs whitespace-pre-wrap break-all my-0.5 mx-2.5 py-2 px-2.5 bg-code-bg border border-border-subtle rounded-lg text-text-secondary max-h-[300px] overflow-y-auto"
			>
				{message.result.replace(/^<skill_content[^>]*>\n?/, "").replace(/\n?<\/skill_content>\s*$/, "")}
			</div>
		{/if}
	</div>
</div>
