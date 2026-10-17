<!-- The Final turn head keeps counts and duration above a shared activity strip.
     Skills, task status and the bill stay in the step log or duration hover.
     Resting on the turn prefetches tool details; a strip tap opens its log row. -->
<script lang="ts">
	import { tick, untrack } from "svelte";
	import { clock } from "../../stores/clock.svelte.js";
	import { revealedPart } from "../../stores/reveal.svelte.js";
	import { getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { shownCut, toolDetails } from "../../stores/tool-details.js";
	import type { BackgroundTask } from "../../../shared-types.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Tooltip from "../ui/Tooltip.svelte";
	import {
		countsPhrase,
		currentStepLabel,
		economics,
		fmtDuration,
		latestStamp,
		liveLaunchedTasks,
		stepCaption,
		type SkillChapter,
		skillChapters,
		stepDurations,
		type Segment,
		type Turn,
		turnStats,
		workingTime,
	} from "../../utils/turns.js";
	import ActivityRow from "./ActivityRow.svelte";
	import ActivityStrip from "./ActivityStrip.svelte";
	import { partStyle } from "./activity-style.js";
	import RunningPill from "./RunningPill.svelte";
	import TurnEconomics from "./TurnEconomics.svelte";
	import AssistantHeader from "./AssistantHeader.svelte";

	let { turn, segment, final, liveTasks = [], taskListedAt = new Map<string, number>(), taskNow = Date.now(), sessionId, forkMessageId, model, providerId, onsummarize, numbered = false }: {
		turn: Turn;
		segment: Segment;
		final: boolean;
		liveTasks?: readonly BackgroundTask[];
		taskListedAt?: ReadonlyMap<string, number>;
		taskNow?: number;
		sessionId?: string | undefined;
		forkMessageId?: string | undefined;
		model?: string | undefined;
		providerId?: string | undefined;
		onsummarize?: (() => void) | undefined;
		numbered?: boolean;
	} = $props();

	let expanded = $state(false);
	let skillsOpen = $state(false);
	let hovered = $state<number | null>(null);
	let focusUuid = $state<string | null>(null);
	let panelEl = $state<HTMLDivElement | undefined>();
	let detailsOpen = $state(false);

	const settledNow = Date.now();
	const now = $derived(final && turn.live ? clock.now : settledNow);

	const stats = $derived(turnStats(segment));
	const durations = $derived(stepDurations(segment, turn, final, now));
	const duration = $derived.by(() => {
		const index = turn.segments.indexOf(segment);
		const until = index === -1 || index === turn.segments.length - 1 ? undefined : latestStamp(segment);
		return workingTime(turn, now, until);
	});
	const bill = $derived(economics(turn, now));
	const running = $derived(liveLaunchedTasks(turn, liveTasks, liveTasks.length > 0 && turn.live ? clock.now : taskNow, taskListedAt));
	const phrase = $derived(countsPhrase(stats));
	const chapters = $derived(skillChapters(segment, turn, final, now));
	const skillSteps = $derived(skillsOpen ? new Set(chapters.map((c) => c.index)) : null);
	const TICKER_ROWS = 3;
	const ticker = $derived(segment.activity.slice(-TICKER_ROWS));
	const live = $derived(final && turn.live);
	const showTicker = $derived(live && segment.reply.length === 0 && !segment.handBack);
	const earlierCount = $derived(Math.max(0, segment.activity.length - ticker.length));
	const previousMessages = $derived(turn.segments.slice(0, turn.segments.indexOf(segment)).reduce((count, item) => count + item.activity.filter((part) => part.type === "assistant").length + item.reply.length, 0));
	function messageNumber(index: number): number | undefined {
		return numbered ? previousMessages + segment.activity.slice(0, index + 1).filter((part) => part.type === "assistant").length : undefined;
	}

	$effect(() => {
		const uuid = revealedPart.request?.uuid;
		untrack(() => {
			const i = segment.activity.findIndex((part) => part.uuid === uuid);
			if (i >= 0) void jumpTo(i);
		});
	});

	const PREFETCH_REST_MS = 2_000;

	let onScreen = $state(false);
	$effect(() => {
		if (!panelEl) return;
		let live = true;
		const observer = new IntersectionObserver((entries) => {
			if (live) onScreen = entries.at(-1)?.isIntersecting ?? false;
		});
		observer.observe(panelEl);
		return () => {
			live = false;
			observer.disconnect();
		};
	});

	const tools = $derived(segment.activity.flatMap((part) => (part.type === "tool" ? [part] : [])));
	// What the finished tools have to load. A change restarts the rest, so a tool
	// that finishes on screen, or whose cut result arrives, is fetched too.
	const toLoad = $derived(
		tools
			.filter(({ status }) => status === "completed" || status === "error")
			.map((tool) => `${tool.id}:${shownCut(tool)}`)
			.join(),
	);
	$effect(() => {
		if (!onScreen) return;
		void toLoad;
		const resting = setTimeout(() => {
			const projectSlug = getCurrentSlug();
			const sessionId = getCurrentSessionId();
			if (projectSlug && sessionId) toolDetails.wantSoon({ projectSlug, sessionId }, tools);
		}, PREFETCH_REST_MS);
		return () => clearTimeout(resting);
	});

	/** "1m 4s in · 12s". Offsets under a second read as the start of the turn. */
	function chapterTiming(c: SkillChapter): string {
		let at: string | undefined;
		if (c.offset !== undefined) {
			at = c.offset < 1000 ? "at start" : `${fmtDuration(c.offset)} in`;
		}
		let span: string | undefined;
		if (c.running) span = "running";
		else if (c.duration !== undefined) span = fmtDuration(c.duration);
		return [at, span].filter(Boolean).join(" · ");
	}

	async function jumpTo(i: number) {
		const part = segment.activity[i];
		if (!part) return;
		expanded = true;
		focusUuid = part.uuid;
		await tick();
		panelEl?.querySelector(`[data-part="${CSS.escape(part.uuid)}"]`)?.scrollIntoView({ block: "nearest" });
	}
</script>

<div bind:this={panelEl} class="turn-activity max-w-[820px] mx-auto px-[14px] md:px-[32px] mt-[6px] mb-[14px]">
	<AssistantHeader message={segment.reply[0]} {sessionId} {forkMessageId} {model} {providerId} createdAt={segment.reply.length > 0 ? undefined : segment.activity[0]?.createdAt} />
	<div class="md:ml-[42px]">
		<div class="turn-head-card @container rounded-[14px] bg-turn-bg px-[12px] pt-[10px] pb-[2px] md:pb-[9px]">
			<div data-testid={live ? "turn-live-head" : undefined} class="flex items-center gap-[6px] min-w-0">
				<Tooltip bind:open={detailsOpen}>
					{#snippet trigger({ props })}
						<Button {...props} variant="ghost" size="content" tone="secondary" hoverFill="none" align="start" touchTarget
							class="turn-activity-toggle gap-[6px] text-[13px] min-w-0" aria-expanded={expanded}
							onclick={() => (expanded = !expanded)}>
							{#if live}<Icon name="loader-circle" size={13} class="animate-spin shrink-0 text-accent" />
							{:else}<Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} class="shrink-0 text-text-muted" />{/if}
							<span class="font-semibold">{live ? "Working" : "Worked"}</span>
							{#if live && !turn.user}
								<span class="text-[12px] text-text-muted" data-testid="turn-live-elapsed">(no prompt to time from)</span>
							{:else if duration !== undefined}
								<span class="turn-duration font-mono text-[12px] text-text-muted shrink-0" data-testid={live ? "turn-live-elapsed" : undefined}>{live && duration < 1000 ? "0s" : fmtDuration(duration)}</span>
							{/if}
							{#if phrase}<span class="truncate text-[12px] text-text-muted">· {phrase}</span>{/if}
						</Button>
					{/snippet}
					<div class="max-w-[340px] flex flex-col gap-[6px] text-[12px]">
						{#if hovered !== null}<span>{stepCaption(segment, turn, final, hovered, now)}</span>{:else if live}<span>{currentStepLabel(segment)}</span>{/if}
						{#if phrase}<span>{phrase}</span>{/if}
						{#if stats.compactions > 0}<span>Context compacted{stats.compactions > 1 ? ` ×${stats.compactions}` : ""}</span>{/if}
						{#if stats.failed > 0}<span>{stats.failed} failed</span>{/if}
						<TurnEconomics economics={bill} />
						{#if final}<RunningPill count={running.size} />{/if}
						<span>Click to {expanded ? "hide" : "show"} the step log</span>
					</div>
				</Tooltip>
				{#if onsummarize}<span class="hidden md:contents"><Button variant="accent-soft" size="content" touchTarget class="rounded-full px-[10px] py-[4px] text-[12px] shrink-0" onclick={onsummarize}>✦ Summarize</Button></span>{/if}
			</div>
			<div class="md:mt-[7px]">
				<ActivityStrip {turn} {segment} {final} {now} {running} active={hovered} emphasis={skillSteps}
					onhover={(index) => { hovered = index; detailsOpen = index !== null; }} onjump={jumpTo} />
			</div>
			{#if onsummarize}
				<Button variant="ghost-accent" size="content" align="start" touchTarget class="md:hidden w-full gap-[8px] py-[8px] text-[13px]" onclick={onsummarize}>
					<span>✦ Summarize</span><Icon name="chevron-right" size={14} class="ml-auto" />
				</Button>
			{/if}
		</div>
		{#if expanded || showTicker}
			<div class="step-log mt-[6px]" data-testid={live ? "turn-live-activity" : undefined}>
				{#if !expanded && earlierCount > 0}
					<Button variant="ghost" size="content" tone="muted" hoverFill="none" align="start" touchTarget
						class="py-[8px] text-[12px]" onclick={() => (expanded = true)}>+ {earlierCount} earlier messages</Button>
				{/if}
				{#each expanded ? segment.activity : ticker as part, index (part.uuid)}
					{@const i = expanded ? index : earlierCount + index}
					{@const latestLiveStep = live && i === segment.activity.length - 1}
					<div data-testid={part.type === "tool" && (part.status === "running" || part.status === "pending" || (latestLiveStep && part.result === undefined && part.status !== "error" && !part.isError)) ? "turn-running" : undefined}>
						<ActivityRow {part} {liveTasks} {taskListedAt} live={latestLiveStep} duration={durations?.[i]} highlight={part.uuid === focusUuid} messageNumber={part.type === "assistant" ? messageNumber(i) : undefined} />
					</div>
				{/each}
				<div class="flex flex-wrap items-center gap-[10px] py-[8px] text-[12px] text-text-muted">
					{#if stats.skills > 0}
						<Button variant="ghost" size="content" tone="muted-soft" hoverFill="none" touchTarget
							class="skills-toggle gap-[5px]" aria-expanded={skillsOpen} onclick={() => (skillsOpen = !skillsOpen)}>
							<Icon name="sparkles" size={12} />{stats.skills} {stats.skills === 1 ? "skill" : "skills"}
						</Button>
					{/if}
					{#if stats.compactions > 0}<span class="compaction-marker">compacted{stats.compactions > 1 ? ` ×${stats.compactions}` : ""}</span>{/if}
					{#if stats.failed > 0}<span class="text-error">{stats.failed} failed</span>{/if}
					{#if final}<RunningPill count={running.size} /><TurnEconomics economics={bill} />{/if}
				</div>
				{#if skillsOpen}
					<ol class="skill-chapters pb-[8px]" aria-label="Skills in this turn">
						{#each chapters as chapter (chapter.index)}
							{@const part = segment.activity[chapter.index]}
							<li><Button variant="ghost" size="content" align="start" tone="inherit" hoverFill="surface" touchTarget
								class="gap-[8px] w-full py-[8px] text-[12px] text-left" onclick={() => jumpTo(chapter.index)}>
								<span class={part ? partStyle(part).text : ""}><Icon name="sparkles" size={14} /></span>
								<span class="flex-1 truncate font-mono text-text-secondary">{chapter.name || "Unnamed skill"}</span>
								<span class="shrink-0 font-mono text-text-muted">{chapterTiming(chapter)}</span>
							</Button></li>
						{/each}
					</ol>
				{/if}
			</div>
		{/if}
	</div>
</div>
