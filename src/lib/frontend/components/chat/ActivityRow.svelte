<!-- ─── Activity Row ────────────────────────────────────────────────────────── -->
<!-- One step in the expanded log: icon · verb · subject · how long it took.      -->
<!-- Click to see the command and its output. Tools that own an interactive card  -->
<!-- (question, subagent, skill) render that card instead of a compact row.       -->
<script lang="ts">
	import BlockGrid from "../shared/BlockGrid.svelte";
	import Icon from "../shared/Icon.svelte";
	import {
		type ActivityPart,
		firstLine,
		fmtDuration,
		isSoloTool,
		toolCommand,
		toolSubject,
		toolVerb,
	} from "../../utils/turns.js";
	import { partStyle } from "./activity-style.js";
	import SkillItem from "./SkillItem.svelte";
	import ToolItem from "./ToolItem.svelte";

	let {
		part,
		duration,
		highlight = false,
	}: { part: ActivityPart; duration?: number | undefined; highlight?: boolean } = $props();

	let expanded = $state(false);

	const style = $derived(partStyle(part));
	const meta = $derived(duration === undefined ? "" : fmtDuration(duration));
	const rowClass =
		"flex items-center gap-2 w-full py-1 px-2 rounded text-xs text-left cursor-pointer hover:bg-[rgba(var(--overlay-rgb),0.04)]";
</script>

{#if part.type === "tool" && isSoloTool(part)}
	<div data-part={part.uuid}>
		{#if part.name === "Skill"}
			<SkillItem message={part} />
		{:else}
			<ToolItem message={part} />
		{/if}
	</div>
{:else if part.type === "tool"}
	{@const running = part.status === "running" || part.status === "pending"}
	{@const failed = part.status === "error" || part.isError}
	{@const command = toolCommand(part)}
	<div data-part={part.uuid} data-tool-id={part.id}>
		<button
			type="button"
			class="{rowClass} {highlight ? 'bg-[rgba(var(--overlay-rgb),0.06)]' : ''}"
			onclick={() => (expanded = !expanded)}
		>
			<span class="shrink-0 {style.text} [&_.lucide]:w-3.5 [&_.lucide]:h-3.5">
				<Icon name={style.icon} size={14} />
			</span>
			<span class="shrink-0 font-medium {running ? 'text-text' : 'text-text-secondary'}">
				{toolVerb(part, running ? "present" : "past")}
			</span>
			<span class="flex-1 truncate font-mono {running ? 'text-text-secondary' : 'text-text-muted'}">
				{toolSubject(part)}
			</span>
			{#if meta}<span class="shrink-0 font-mono text-text-dimmer">{meta}</span>{/if}
			{#if running}
				<BlockGrid cols={4} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
			{:else if failed}
				<span class="shrink-0 text-error [&_.lucide]:w-3 [&_.lucide]:h-3">
					<Icon name="circle-alert" size={12} />
				</span>
			{/if}
		</button>
		{#if expanded && (part.result || command)}
			<div
				class="ml-7 mr-1 my-1 py-2 px-2.5 font-mono text-xs whitespace-pre-wrap break-all bg-code-bg border rounded-lg max-h-[300px] overflow-y-auto {part.isError ? 'border-error/30 text-error' : 'border-border-subtle text-text-secondary'}"
			>{#if command}<span class="text-text-muted">$ {command}</span>{#if part.result}{"\n\n"}{/if}{/if}{part.result ?? ""}</div>
		{/if}
	</div>
{:else if part.type === "thinking"}
	<div data-part={part.uuid}>
		<button type="button" class={rowClass} onclick={() => (expanded = !expanded)}>
			<span class="shrink-0 {style.text} [&_.lucide]:w-3.5 [&_.lucide]:h-3.5">
				<Icon name={style.icon} size={14} />
			</span>
			<span class="shrink-0 font-medium text-text-secondary">{part.done ? "Thought" : "Thinking"}</span>
			<span class="flex-1 truncate text-text-dimmer italic">{firstLine(part.text, 80)}</span>
			{#if meta}<span class="shrink-0 font-mono text-text-dimmer">{meta}</span>{/if}
			{#if !part.done}<BlockGrid cols={4} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />{/if}
		</button>
		{#if expanded && part.text}
			<div
				class="ml-7 mr-1 my-1 py-2 px-2.5 font-mono text-xs whitespace-pre-wrap break-words text-text-secondary bg-code-bg border border-border-subtle rounded-lg max-h-[300px] overflow-y-auto"
			>{part.text}</div>
		{/if}
	</div>
{:else}
	<div data-part={part.uuid}>
		<button type="button" class={rowClass} onclick={() => (expanded = !expanded)}>
			<span class="shrink-0 {style.text} [&_.lucide]:w-3.5 [&_.lucide]:h-3.5">
				<Icon name={style.icon} size={14} />
			</span>
			<span class="flex-1 truncate text-text-secondary">{firstLine(part.rawText, 120)}</span>
			{#if meta}<span class="shrink-0 font-mono text-text-dimmer">{meta}</span>{/if}
		</button>
		{#if expanded}
			<div class="ml-7 mr-1 my-1 md-content text-xs leading-[1.6] text-text-secondary">{@html part.html}</div>
		{/if}
	</div>
{/if}
