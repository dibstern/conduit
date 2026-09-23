<!-- ─── Activity Row ────────────────────────────────────────────────────────── -->
<!-- One step in the expanded log: icon · verb · subject · how long it took.      -->
<!-- Click to see the command and its output.                                     -->
<!--                                                                              -->
<!-- Skills and subagents used to render full cards here, which broke the log's    -->
<!-- rhythm and nested a second transcript gutter inside the panel. They are rows  -->
<!-- like everything else now, marked by a coloured rail because loading a         -->
<!-- capability or handing work to another agent is a different kind of step than  -->
<!-- reading a file.                                                               -->
<script lang="ts">
	import BlockGrid from "../ui/BlockGrid.svelte";
	import Icon from "../ui/Icon.svelte";
	import {
		type ActivityPart,
		firstLine,
		fmtDuration,
		fmtTokens,
		isSoloTool,
		thinkingVerb,
		toolCommand,
		toolSubject,
		toolTags,
		toolVerb,
	} from "../../utils/turns.js";
	import { isSubagentToolName, subagentSessionId } from "../../utils/subagent-tools.js";
	import { switchToSession } from "../../stores/session.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { getSkillContentRpc } from "../../transport/ws-rpc-client.js";
	import { renderMarkdown } from "../../utils/markdown.js";
	import { partStyle } from "./activity-style.js";

	let {
		part,
		duration,
		highlight = false,
	}: { part: ActivityPart; duration?: number | undefined; highlight?: boolean } = $props();

	let expanded = $state(false);

	const style = $derived(partStyle(part));
	const meta = $derived(duration === undefined ? "" : fmtDuration(duration));
	const railed = $derived(part.type === "tool" && isSoloTool(part));
	const childSession = $derived(
		part.type === "tool" && isSubagentToolName(part.name) ? subagentSessionId(part) : null,
	);

	/** Sessions recorded before Skill inputs were normalized carry the name only
	 *  in the result text, so recover it rather than showing a nameless row. */
	const legacySkillName = $derived.by(() => {
		if (part.type !== "tool" || part.name !== "Skill") return "";
		const match = part.result?.match(
			/^<skill_content\b[^>]*(?:name|skill_name)=["']([^"']+)["']|^"?Launching skill: ([^"\s]+)/,
		);
		return match?.[1] ?? match?.[2] ?? "";
	});

	// The Skill tool's result is only ever "Launching skill: <name>" — the
	// instructions themselves are injected into the model's context and never
	// reach us. Read the file off disk instead, on demand.
	let skillDoc = $state<string | null>(null);
	let skillState = $state<"idle" | "loading" | "missing">("idle");

	function loadSkillDoc(name: string) {
		const slug = getCurrentSlug();
		if (!slug || !name || skillState !== "idle") return;
		skillState = "loading";
		void getSkillContentRpc({ projectSlug: slug, name })
			.then((response) => {
				skillDoc = response.content;
				skillState = "idle";
			})
			.catch(() => {
				skillState = "missing";
			});
	}

	const rowClass =
		"flex items-center gap-2 w-full py-1 px-2 rounded text-xs text-left cursor-pointer hover:bg-[rgba(var(--overlay-rgb),0.04)]";
</script>

{#if part.type === "tool"}
	{@const running = part.status === "running" || part.status === "pending"}
	{@const failed = part.status === "error" || part.isError}
	{@const command = toolCommand(part)}
	{@const subject = toolSubject(part) || legacySkillName}
	{@const tag = toolTags(part)[0]}
	{@const isSkill = part.name === "Skill"}
	<!-- A compact row is still this tool's rendering, so it answers to the same
	     .tool-item / data-tool-status hooks the expanded card used to. -->
	<div class="tool-item relative" data-part={part.uuid} data-tool-id={part.id} data-tool-status={part.status}>
		{#if railed}
			<!-- Out of flow on purpose: an inline rail would shift these rows a
			     couple of pixels right and break the icon column every other row. -->
			<span class="absolute left-0 top-1 bottom-1 w-0.5 rounded-full opacity-70 {style.bg}" aria-hidden="true"></span>
		{/if}
		<div class="flex items-center gap-1.5">
			<button
				type="button"
				class="{rowClass} {highlight ? 'bg-[rgba(var(--overlay-rgb),0.06)]' : ''}"
				onclick={() => {
					expanded = !expanded;
					if (expanded && isSkill) loadSkillDoc(subject);
				}}
			>
				<span class="shrink-0 {style.text} [&_.lucide]:w-3.5 [&_.lucide]:h-3.5">
					<Icon name={style.icon} size={14} />
				</span>
				<span class="shrink-0 font-medium {running ? 'text-text' : 'text-text-secondary'}">
					{toolVerb(part, running ? "present" : "past")}
				</span>
				{#if tag}
					<!-- Which kind of subagent ran. Worth its own slot: two Task rows
					     differ by this far more than by their descriptions. -->
					<span class="shrink-0 px-1.5 py-px rounded font-mono text-[10px] {style.text} bg-[rgba(var(--overlay-rgb),0.06)]">{tag}</span>
				{/if}
				<span class="flex-1 truncate font-mono {running ? 'text-text-secondary' : 'text-text-muted'}">
					{subject}
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
			{#if childSession}
				<!-- Opening the child session is its own action, so it gets its own
				     control rather than stealing the row's click from expansion. -->
				<button
					type="button"
					class="subagent-link shrink-0 self-center px-1.5 py-1 rounded text-text-dimmer hover:text-accent hover:bg-[rgba(var(--overlay-rgb),0.04)] cursor-pointer [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"
					title="Open subagent session"
					aria-label="Open subagent session"
					onclick={() => switchToSession(childSession)}
				>
					<Icon name="arrow-right" size={14} />
				</button>
			{/if}
		</div>
		{#if expanded && isSkill}
			<div class="ml-7 mr-1 my-1 py-2 px-2.5 bg-code-bg border border-border-subtle rounded-lg max-h-[300px] overflow-y-auto">
				{#if skillDoc}
					<div class="md-content text-xs leading-[1.6] text-text-secondary">{@html renderMarkdown(skillDoc)}</div>
				{:else}
					<span class="font-mono text-xs text-text-muted">
						{skillState === "loading" ? "Loading skill…" : "This skill's file could not be found on disk."}
					</span>
				{/if}
			</div>
		{:else if expanded && (part.result || command)}
			<div
				class="ml-7 mr-1 my-1 py-2 px-2.5 font-mono text-xs whitespace-pre-wrap break-all bg-code-bg border rounded-lg max-h-[300px] overflow-y-auto {part.isError ? 'border-error/30 text-error' : 'border-border-subtle text-text-secondary'}"
			>{#if command}<span class="text-text-muted">$ {command}</span>{#if part.result}{"\n\n"}{/if}{/if}{part.result ?? ""}</div>
		{/if}
	</div>
{:else if part.type === "thinking"}
	<!-- .thinking-* and .done are E2E hooks: the visual-mockup spec rewrites the
	     verb and the duration through them to keep screenshots deterministic. -->
	<div class="thinking-block thinking-item" class:done={part.done} data-part={part.uuid}>
		<button type="button" class={rowClass} onclick={() => (expanded = !expanded)}>
			<span class="shrink-0 {style.text} [&_.lucide]:w-3.5 [&_.lucide]:h-3.5">
				<Icon name={style.icon} size={14} />
			</span>
			<span class="thinking-label shrink-0 font-medium text-text-secondary">{part.done ? "Thought" : thinkingVerb(part)}</span>
			<span class="flex-1 truncate text-text-dimmer italic">{firstLine(part.text, 80)}</span>
			{#if meta}<span class="thinking-duration shrink-0 font-mono text-text-dimmer">{meta}</span>{/if}
			{#if !part.done}<BlockGrid cols={4} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />{/if}
		</button>
		{#if expanded && part.text}
			<div
				class="ml-7 mr-1 my-1 py-2 px-2.5 font-mono text-xs whitespace-pre-wrap break-words text-text-secondary bg-code-bg border border-border-subtle rounded-lg max-h-[300px] overflow-y-auto"
			>{part.text}</div>
		{/if}
	</div>
{:else if part.type === "system"}
	{@const { preTokens: pre, postTokens: post } = part}
	<!-- A boundary, not a step: there is nothing to open, so it is a rule across
	     the log rather than a row. The saving is the one number worth reading. -->
	<div
		class="compaction-rule flex items-center gap-2 py-1.5 px-2 rounded text-xs {style.text} {highlight ? 'bg-[rgba(var(--overlay-rgb),0.06)]' : ''}"
		data-part={part.uuid}
	>
		<span class="h-px flex-1 bg-border" aria-hidden="true"></span>
		<span class="shrink-0 [&_.lucide]:w-3 [&_.lucide]:h-3" aria-hidden="true"><Icon name={style.icon} size={12} /></span>
		<span class="shrink-0">Compacted context</span>
		{#if pre !== undefined && post !== undefined}
			<span class="shrink-0 font-mono text-text-dimmer">{fmtTokens(pre)} → {fmtTokens(post)}</span>
			{#if pre > post}
				<span class="shrink-0 text-text-dimmer">·</span>
				<span class="shrink-0 font-medium text-text-secondary">{fmtTokens(pre - post)} saved</span>
			{/if}
		{/if}
		<span class="h-px flex-1 bg-border" aria-hidden="true"></span>
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
