<!-- One step in the expanded log: icon · verb · subject · how long it took.      -->
<!-- Click to see foreground output or open a background agent's task.            -->
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
		launchMeta,
		launchRow,
		launchStatus,
		launchUsage,
		plural,
		thinkingVerb,
		toolCommand,
		skillName,
		toolSubject,
		toolTags,
		toolVerb,
	} from "../../utils/turns.js";
	import { isSubagentToolName, subagentSessionId } from "../../utils/subagent-tools.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { selection } from "../../stores/selection.svelte.js";
	import { openTask } from "../session/background-tasks.svelte.js";
	import type { BackgroundTask } from "../../../shared-types.js";
	import { partStyle } from "./activity-style.js";
	import { ensureCanonical } from "../../utils/tool-summarizers/ensure-canonical.js";
	import SkillDoc from "./SkillDoc.svelte";
	import ToolFullDetail from "./ToolFullDetail.svelte";

	let {
		part,
		liveTasks,
		taskListedAt,
		duration,
		highlight = false,
	}: {
		part: ActivityPart;
		liveTasks: readonly BackgroundTask[];
		taskListedAt: ReadonlyMap<string, number>;
		duration?: number | undefined;
		highlight?: boolean;
	} = $props();

	let expanded = $state(false);

	const style = $derived(partStyle(part));
	const meta = $derived(duration === undefined ? "" : fmtDuration(duration));
	const railed = $derived(part.type === "tool" && isSoloTool(part));
	// A step that launched a background task tracks that task. Foreground tasks
	// stay ordinary steps.
	const taskId = $derived(part.type === "tool" ? part.metadata?.["providerTaskId"] : undefined);
	const launch = $derived.by(() => {
		if (part.type !== "tool" || typeof taskId !== "string") return undefined;
		const row = launchRow(part, liveTasks, clock.now, taskListedAt.get(taskId));
		return row?.state.kind === "foreground" ? undefined : row;
	});
	const launchTone = $derived(
		launch?.state.kind === "running"
			? "text-brand-b"
			: launch?.state.kind === "finished"
				? { completed: "text-success", failed: "text-error", stopped: "text-warning" }[launch.state.outcome]
				: "text-text-dimmer",
	);
	const childSession = $derived(
		part.type === "tool" && isSubagentToolName(part.name) ? subagentSessionId(part) : null,
	);

	function openChildSession(description: string) {
		if (!childSession) return;
		if (!launch || typeof taskId !== "string") return selection.open(childSession);
		// Transcript step uuids read "<message id>/<part id>".
		const [messageId = part.uuid, partId] = part.uuid.split(/\/(.*)/s);
		openTask({ id: taskId, sessionId: childSession, description }, { messageId, partId });
	}

	const rowClass =
		"flex items-center gap-2 w-full min-w-0 py-1 px-2 rounded text-xs text-left cursor-pointer hover:bg-[rgba(var(--overlay-rgb),0.04)]";
</script>

{#if part.type === "tool"}
	{@const running = launch ? launch.state.kind === "running" : part.status === "running" || part.status === "pending"}
	{@const failed = part.status === "error" || part.isError}
	{@const verb = toolVerb(part, running ? "present" : "past")}
	{@const command = toolCommand(part)}
	{@const subject = part.name === "Skill" ? skillName(part) : toolSubject(part)}
	{@const tag = toolTags(part)[0]}
	{@const isSkill = part.name === "Skill"}
	{@const cursorDetail = typeof part.metadata?.['cursorToolType'] === "string" && (part.metadata['fileChange'] || part.metadata['plan'] || part.metadata['computerUse'] || part.metadata['media'] || part.metadata['output'] !== undefined || ensureCanonical(part.name, part.input).tool === "Unknown")}
	<!-- A compact row is still this tool's rendering, so it answers to the same
	     .tool-item / data-tool-status hooks the expanded card used to. -->
	<div
		class="tool-item relative"
		data-part={part.uuid}
		data-tool-id={part.id}
		data-tool-status={part.status}
		data-launch-state={launch?.state.kind === "finished" ? launch.state.outcome : launch?.state.kind}
	>
		{#if railed}
			<!-- Out of flow on purpose: an inline rail would shift these rows a
			     couple of pixels right and break the icon column every other row. -->
			<span class="absolute left-0 top-1 bottom-1 w-0.5 rounded-full opacity-70 {style.bg}" aria-hidden="true"></span>
		{/if}
		<div class="flex items-center gap-1.5">
			<button
				type="button"
				class="{rowClass} {launch ? '@container min-h-[24px]' : ''} {highlight ? 'bg-[rgba(var(--overlay-rgb),0.06)]' : ''}"
				disabled={!!launch && !childSession}
				aria-label={launch
					? [
							`${verb} ${subject}`,
							launchStatus(launch.state),
							launch.step,
							launch.time === undefined ? undefined : fmtDuration(launch.time),
							launch.nested > 0 ? `${plural(launch.nested, "nested task")} running` : undefined,
						]
							.filter(Boolean)
							.join(", ")
					: undefined}
				onclick={() => {
					if (launch) return openChildSession(subject);
					expanded = !expanded;
				}}
			>
				<span class="shrink-0 {style.text} [&_.lucide]:w-3.5 [&_.lucide]:h-3.5">
					<Icon name={style.icon} size={14} />
				</span>
				<span class="shrink-0 font-medium {running ? 'text-text' : 'text-text-secondary'}">
					{verb}
				</span>
				{#if tag}
					<!-- Which kind of subagent ran. Worth its own slot: two Task rows
					     differ by this far more than by their descriptions. -->
					<span class="shrink-0 px-1.5 py-px rounded font-mono text-[10px] {style.text} bg-[rgba(var(--overlay-rgb),0.06)]">{tag}</span>
				{/if}
				<span class="{launch?.step ? 'min-w-0 max-w-[50%]' : 'flex-1'} truncate font-mono {running ? 'text-text-secondary' : 'text-text-muted'}">
					{subject}
				</span>
				{#if typeof part.metadata?.['cursorToolType'] === "string" && part.metadata['truncated'] === true}<span class="shrink-0 text-text-muted">Truncated</span>{/if}
				{#if launch}
					<!-- One line per task: what it is doing now, how long, and what it
					     used. The outcome's colour carries failed vs stopped too. -->
					{#if launch.step}
						<span class="launch-step flex-1 min-w-0 truncate text-text-dimmer">· {launch.step}</span>
					{/if}
					{#if launch.nested > 0}
						<span class="launch-nested shrink-0 px-1.5 py-px rounded font-mono text-[10px] text-text-secondary bg-[rgba(var(--overlay-rgb),0.06)]">+{plural(launch.nested, "task")}</span>
					{/if}
					{@const lead = launchMeta(launch)}
					{@const usage = launchUsage(launch)}
					<!-- Status and time stay whole; a narrow row drops the usage. -->
					<span class="launch-meta shrink-0 whitespace-nowrap font-mono"><span class={launchTone}>{lead}</span>{#if usage}<span class="text-text-dimmer @max-[480px]:hidden">{lead ? " · " : ""}{usage}</span>{/if}</span>
				{:else if meta}<span class="shrink-0 font-mono text-text-dimmer">{meta}</span>{/if}
				{#if launch?.state.kind === "finished"}
					<span class="shrink-0 {launchTone} [&_.lucide]:w-3 [&_.lucide]:h-3" aria-hidden="true">
						<Icon name={{ completed: "circle-check", failed: "circle-x", stopped: "circle-stop" }[launch.state.outcome]} size={12} />
					</span>
				{:else if running}
					<BlockGrid cols={4} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
				{:else if failed}
					<span class="shrink-0 text-error [&_.lucide]:w-3 [&_.lucide]:h-3">
						<Icon name="circle-alert" size={12} />
					</span>
				{/if}
			</button>
			{#if childSession}
				<!-- Foreground rows expand; their arrow opens the child session.
				     Background rows and arrows both open the task. -->
				<button
					type="button"
					class="subagent-link min-w-[24px] min-h-[24px] shrink-0 self-center px-1.5 py-1 rounded text-text-dimmer hover:text-accent hover:bg-[rgba(var(--overlay-rgb),0.04)] cursor-pointer [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"
					title="Open subagent session"
					aria-label="Open subagent session"
					onclick={() => openChildSession(subject)}
				>
					<Icon name="arrow-right" size={14} />
				</button>
			{/if}
		</div>
		{#if childSession && (typeof part.metadata?.['subagentModel'] === "string" || typeof part.metadata?.['subagentMode'] === "string")}
			<div class="subagent-details ml-7 mr-1 pb-1 text-xs text-text-muted break-words">
				{[part.metadata?.['subagentModel'], part.metadata?.['subagentMode']].filter((value) => typeof value === "string").join(" · ")}
			</div>
		{/if}
		{#if !launch && expanded && isSkill}
			<div class="ml-7 mr-1 my-1"><SkillDoc name={subject} /></div>
		{:else if !launch && expanded && (part.result || command || cursorDetail)}
			<ToolFullDetail message={part} class="ml-7 mr-1 mb-1">
				{#snippet children(tool)}
					{@const fullCommand = toolCommand(tool)}
					<div
						class="tool-result ml-7 mr-1 my-1 py-2 px-2.5 font-mono text-xs whitespace-pre-wrap break-all bg-code-bg border rounded-lg max-h-[300px] overflow-y-auto {tool.isError ? 'border-error/30 text-error' : 'border-border-subtle text-text-secondary'}"
					>{#if fullCommand}<span class="text-text-muted">$ {fullCommand}</span>{#if tool.result}{"\n\n"}{/if}{/if}{tool.result ?? ""}</div>
				{/snippet}
			</ToolFullDetail>
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
