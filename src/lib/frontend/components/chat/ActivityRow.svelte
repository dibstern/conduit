<!-- One step in the expanded log: icon · verb · subject · how long it took.      -->
<!-- Click to see foreground output or open a background agent's task.            -->
<script lang="ts">
	import BlockGrid from "../ui/BlockGrid.svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import {
		type ActivityPart,
		firstLine,
		fmtDuration,
		fmtTokens,
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
	import { partStyle, segmentAppearance } from "./activity-style.js";
	import { ensureCanonical } from "../../utils/tool-summarizers/ensure-canonical.js";
	import SkillDoc from "./SkillDoc.svelte";
	import ToolFullDetail from "./ToolFullDetail.svelte";

	let {
		part,
		liveTasks,
		taskListedAt,
		duration,
		highlight = false,
		messageNumber,
		live = false,
		runningTasks = new Set<string>(),
	}: {
		part: ActivityPart;
		liveTasks: readonly BackgroundTask[];
		taskListedAt: ReadonlyMap<string, number>;
		duration?: number | undefined;
		highlight?: boolean;
		messageNumber?: number | undefined;
		live?: boolean;
		/** Shared with the strip so status overrides use the same snapshot. */
		runningTasks?: ReadonlySet<string>;
	} = $props();

	let expanded = $state(false);

	const style = $derived(partStyle(part));
	const iconTone = $derived(segmentAppearance(part, runningTasks).tone);
	const iconColor = $derived(iconTone === "fail" ? "text-seg-fail" : iconTone === "live" ? "text-accent" : style.text);
	const meta = $derived(duration === undefined ? "" : fmtDuration(duration));
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
			? "text-success"
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

</script>

{#if part.type === "tool"}
	{@const running = launch ? launch.state.kind === "running" : part.status === "running" || part.status === "pending" || (live && part.result === undefined && part.status !== "error" && !part.isError)}
	{@const failed = part.status === "error" || part.isError}
	{@const movedToBackground = part.metadata?.['movedToBackground'] === true}
	{@const verb = movedToBackground ? "Moved to background" : toolVerb(part, running ? "present" : "past")}
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
		<div class="flex items-center gap-[6px]">
			<Button
				variant="ghost" size="transcript" layout="flow" tone="inherit" hoverFill="surface" disabledStyle="undimmed"
				class="{launch ? '@container' : ''} {highlight ? 'bg-selection' : ''}"
				disabled={!!launch && !childSession}
				aria-expanded={launch ? undefined : expanded}
				ariaLabel={launch
					? [
							`${verb} ${subject}`,
							launchStatus(launch.state),
							launch.step,
							launch.time === undefined ? undefined : fmtDuration(launch.time),
							launch.nested > 0 ? `${plural(launch.nested, "nested task")} running` : undefined,
						]
							.filter(Boolean)
							.join(", ")
					: `${verb} ${subject}`}
				onclick={() => {
					if (launch) return openChildSession(subject);
					expanded = !expanded;
				}}
			>
				<span class="shrink-0 {iconColor}">
					<Icon name={style.icon} size={14} />
				</span>
				<span class="tool-name shrink-0 font-normal text-text-muted">
					{verb}
				</span>
				{#if tag}
					<!-- Which kind of subagent ran. Worth its own slot: two Task rows
					     differ by this far more than by their descriptions. -->
					<Badge variant="tag" size="sm" class="shrink-0 font-mono">{tag}</Badge>
				{/if}
				<span class="tool-desc {launch?.step ? 'min-w-0 max-w-[50%]' : 'flex-1 min-w-0'} truncate font-mono text-mono-code text-text-dimmer">
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
						<Badge variant="tag" size="sm" class="launch-nested shrink-0 font-mono">+{plural(launch.nested, "task")}</Badge>
					{/if}
					{@const lead = launchMeta(launch)}
					{@const usage = launchUsage(launch)}
					<!-- Status and time stay whole; a narrow row drops the usage. -->
					<span class="launch-meta ml-auto shrink-0 whitespace-nowrap font-mono text-mono-time"><span class={launchTone}>{lead}</span>{#if usage}<span class="text-text-dimmer @max-[480px]:hidden">{lead ? " · " : ""}{usage}</span>{/if}</span>
				{:else if meta}<time class="ml-auto shrink-0 font-mono text-mono-time text-text-dimmer">{meta}</time>{/if}
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
			</Button>
			{#if childSession}
				<!-- Foreground rows expand; their arrow opens the child session.
				     Background rows and arrows both open the task. -->
				<Button
					variant="ghost" size="content" tone="muted" hoverFill="surface"
					class="subagent-link min-w-[44px] min-h-[44px] md:min-w-[28px] md:min-h-[28px] shrink-0 self-center"
					title="Open subagent session"
					ariaLabel="Open subagent session"
					onclick={() => openChildSession(subject)}
				>
					<Icon name="arrow-right" size={14} />
				</Button>
			{/if}
		</div>
		{#if childSession && (typeof part.metadata?.['subagentModel'] === "string" || typeof part.metadata?.['subagentMode'] === "string")}
			<div class="subagent-details ml-[22px] mr-[4px] pb-[3px] text-[12px] text-text-muted break-words">
				{[part.metadata?.['subagentModel'], part.metadata?.['subagentMode']].filter((value) => typeof value === "string").join(" · ")}
			</div>
		{/if}
		{#if !launch && expanded && isSkill}
			<div class="ml-[22px] mr-[4px] my-[4px]"><SkillDoc name={subject} /></div>
		{:else if !launch && expanded && (part.result || command || cursorDetail)}
			<ToolFullDetail message={part} class="ml-[22px] mr-[4px] mb-[4px]">
				{#snippet children(tool)}
					{@const fullCommand = toolCommand(tool)}
					<div
						class="tool-result my-[4px] py-[8px] px-[10px] font-mono text-mono-xs leading-[1.6] whitespace-pre-wrap break-all bg-code-bg rounded-[6px] max-h-[300px] overflow-y-auto {tool.isError ? 'text-error' : 'text-text-secondary'}"
					>{#if fullCommand}<span class="text-text-muted">$ {fullCommand}</span>{#if tool.result}{"\n\n"}{/if}{/if}{tool.result ?? ""}</div>
				{/snippet}
			</ToolFullDetail>
		{/if}
	</div>
{:else if part.type === "thinking"}
	<div class="thinking-block thinking-item" class:done={part.done} data-part={part.uuid}>
		<Button variant="ghost" size="transcript" layout="flow" tone="inherit" hoverFill="surface" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
			<span class="shrink-0 {style.text}">
				<Icon name={style.icon} size={14} />
			</span>
			<span class="thinking-label shrink-0 font-medium text-text-secondary">{part.done ? "Thought" : thinkingVerb(part)}</span>
			<span class="flex-1 truncate text-text-dimmer italic">{firstLine(part.text, 80)}</span>
			{#if meta}<span class="thinking-duration shrink-0 font-mono text-mono-time text-text-dimmer">{meta}</span>{/if}
			{#if !part.done}<BlockGrid cols={4} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />{/if}
		</Button>
		{#if expanded && part.text}
			<div
				class="ml-[22px] mr-[4px] my-[4px] py-[8px] px-[10px] font-mono text-mono-xs leading-[1.6] whitespace-pre-wrap break-words text-text-secondary bg-code-bg border border-border-subtle rounded-[6px] max-h-[300px] overflow-y-auto"
			>{part.text}</div>
		{/if}
	</div>
{:else if part.type === "system"}
	{@const { preTokens: pre, postTokens: post } = part}
	<!-- A boundary, not a step: there is nothing to open, so it is a rule across
	     the log rather than a row. The saving is the one number worth reading. -->
	<div
		class="compaction-rule flex items-center gap-[8px] py-[6px] text-[12px] text-text-dimmer {highlight ? 'bg-selection' : ''}"
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
	<div data-part={part.uuid} data-message-number={messageNumber} data-highlighted={highlight || undefined}>
		<Button variant="ghost" size="transcript" layout="flow" tone="inherit" hoverFill="surface" class={highlight ? "bg-selection" : ""} aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
			{#if messageNumber !== undefined}<span class="shrink-0 font-mono text-mono-xs {style.text}">#{messageNumber}</span>
			{:else}<span class="shrink-0 {style.text}"><Icon name={style.icon} size={14} /></span>{/if}
			<span class="flex-1 truncate italic text-text-secondary">{firstLine(part.rawText, 120)}</span>
			{#if meta}<span class="shrink-0 font-mono text-mono-time text-text-dimmer">{meta}</span>{/if}
		</Button>
		{#if expanded}
			<div class="ml-[22px] mr-[4px] my-[4px] md-content text-[13px] leading-[1.6] italic text-text-secondary">{@html part.html}</div>
		{/if}
	</div>
{/if}
