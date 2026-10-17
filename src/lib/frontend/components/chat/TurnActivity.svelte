<!-- The Final turn head keeps counts and duration above a shared activity strip.
     Skills, task status and the bill stay in the step log or duration hover.
     Resting on the turn prefetches tool details; a strip tap opens its log row. -->
<script lang="ts">
	import { onDestroy, tick, untrack } from "svelte";
	import type { CategorySet } from "../../../contracts/category-set.js";
	import type { MessageSurfacingStatus } from "../../../contracts/message-surfacing.js";
	import { messageSurfacing, sessionSurfaceLevel, setSessionSurfaceLevel, touchSurfaceSession, makeSurfaceDefault } from "../../stores/message-surfacing.svelte.js";
	import { surfaceTurn, surfaceTime, type SurfaceLevel, type SurfacePart, type SurfacePin } from "../../utils/surface-turn.js";
	import SurfacingCard, { type SurfacingRegions } from "./SurfacingCard.svelte";
	import { MARK_GLYPHS, SurfacingFeedback } from "../../stores/surfacing-feedback.svelte.js";
	import SurfacingMarkActions from "./SurfacingMarkActions.svelte";
	import SurfacingMarkWhy from "./SurfacingMarkWhy.svelte";
	import { clock } from "../../stores/clock.svelte.js";
	import { reveal, revealedPart } from "../../stores/reveal.svelte.js";
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
		stripLayout,
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

	let { turn, segment, final, liveTasks = [], taskListedAt = new Map<string, number>(), taskNow = Date.now(), sessionId, forkMessageId, model, providerId, onsummarize, numbered = false, latestTurn = true, surfacing, surfacingRegions = {}, onSurfacingShortcut, hasRecap = false }: {
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
		latestTurn?: boolean;
		surfacing?: { status: MessageSurfacingStatus; categorySet: CategorySet };
		surfacingRegions?: SurfacingRegions;
		hasRecap?: boolean;
		onSurfacingShortcut?: (key: string) => boolean | undefined;
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
		const request = revealedPart.request;
		untrack(() => {
			if (!request || request.sessionId !== sessionId) return;
			const i = segment.activity.findIndex((part) => part.uuid === request.uuid);
			if (i >= 0) {
				const target = surfacingActive ? surface.messages.find(({ part }) => part.uuid === request.uuid) : undefined;
				if (target && (live || target.part.surfacingProbabilities !== undefined)) {
					if (level === "final") selectLevel("all");
					pick(target);
				} else void jumpTo(i);
			}
		});
	});

	const surfacingConfig = $derived(surfacing ?? messageSurfacing);
	const surfacingActive = $derived(surfacingConfig.status.active && surfacingConfig.status.enabled && surfacingConfig.status.key.source !== "none" && !surfacingConfig.status.key.rejected);
	const override = $derived(sessionSurfaceLevel(sessionId));
	const level = $derived(override ?? surfacingConfig.status.defaultLevel);
	let picked = $state<string | null>(null);
	let folded = $state<boolean | null>(null);
	let digits = "";
	const feedback = new SurfacingFeedback(() => sessionId, () => surfacingConfig.categorySet, (place) => {
		void tick().then(() => {
			const target = place === "card" ? panelEl?.querySelector<HTMLElement>('[data-testid="surfacing-msg-card"]') : panelEl?.querySelector<HTMLElement>(`[data-testid="${place}"] button`);
			target?.focus({ preventScroll: true });
		});
	}, pick, (uuid) => { const part = segment.activity.find((part) => part.uuid === uuid); return part?.type === "assistant" ? part : undefined; });
	onDestroy(() => feedback.dispose());
	const surface = $derived(surfaceTurn({
		parts: segment.activity.map((part) => part.type === "assistant" ? feedback.annotate(part) : part), turnParts: turn.segments.flatMap((block) => block.activity.map((part) => part.type === "assistant" ? feedback.annotate(part) : part)),
		positions: stripLayout(segment, turn, final, now), categorySet: surfacingConfig.categorySet,
		level, live, latestTurn, latestBlock: final, hasRecap, picked, folded, start: turn.user?.createdAt ?? segment.activity[0]?.createdAt ?? 0,
	}));
	$effect(() => {
		if (sessionId && surfacingActive) untrack(() => touchSurfaceSession(sessionId));
	});

	function pick(pin: SurfacePin) {
		picked = pin.part.uuid;
		folded = false;
	}
	function selectLevel(next: SurfaceLevel) {
		if (sessionId) setSessionSurfaceLevel(sessionId, next);
		picked = null;
		folded = false;
	}
	function followLatest() { picked = null; folded = false; }
	function foldMessage() {
		folded = true;
		void tick().then(() => panelEl?.querySelector<HTMLElement>('[data-testid="surfacing-scrub"]')?.focus({ preventScroll: true }));
	}
	function revealMessage(part: SurfacePart | null) {
		if (part) void reveal({ sessionId, uuid: part.uuid });
	}
	function surfaceCommand(event: KeyboardEvent) {
		const target = event.target;
		if (!event.defaultPrevented && event.key === "Escape" && feedback.pending) { event.preventDefault(); feedback.cancel(); return; }
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
		if (/^\d$/.test(event.key)) { event.preventDefault(); digits = (digits + event.key).slice(-8); return; }
		const key = event.key;
		if (key === "Enter" && !digits) return;
		if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter", "Escape", "a", "u", "s", "r", "m", "h", "+", "-", "−"].includes(key)) { digits = ""; return; }
		// Plain session shortcuts bubble to SessionBar; focused-turn keys own them first.
		event.preventDefault();
		if (onSurfacingShortcut?.(key)) return;
		if (feedback.command(key, surface.card)) return;
		if (key === "ArrowLeft" && surface.previous) pick(surface.previous);
		else if (key === "ArrowRight" && surface.next) pick(surface.next);
		else if (key === "Home" && surface.first) pick(surface.first);
		else if (key === "End" && surface.last) pick(surface.last);
		else if (key === "Enter" && digits) {
			const target = surface.numbers.find(({ number }) => number === Number(digits));
			if (target) { if (target.belowLevel) selectLevel("all"); revealMessage(target.part); }
		} else if (key === "a") revealMessage(surface.openAsk);
		else if (key === "u") revealMessage(surface.nextUnread?.part ?? null);
		else if (key === "Escape") foldMessage();
		digits = "";
	}
	function surfaceJump(x: number) {
		const positions = stripLayout(segment, turn, final, now);
		const i = positions.findIndex((position) => x <= position.left + position.width);
		const index = i < 0 ? segment.activity.length - 1 : i;
		const pin = surface.pins.find((pin) => pin.step === index);
		if (pin) pick(pin);
		else void jumpTo(index);
	}
	function surfaceHover(x: number | null) {
		const positions = stripLayout(segment, turn, final, now);
		hovered = x === null ? null : positions.findIndex((position) => x <= position.left + position.width);
		detailsOpen = hovered !== null && hovered >= 0;
	}

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

{#snippet markLabel(pin: SurfacePin)}
	{#if pin.part.surfacingMark}
		{@const mark = pin.part.surfacingMark}
		<span class="max-w-full break-words text-[12px] font-medium" style:color={mark.direction === "raise" ? "var(--color-success)" : mark.direction === "retype" ? "var(--color-accent)" : "var(--color-text-secondary)"} data-testid="surfacing-mark-label">{MARK_GLYPHS[mark.direction ?? "raise"]} you{mark.reason ? ` · ${mark.reason}` : ""}</span>
	{/if}
{/snippet}

{#snippet markHead(pin: SurfacePin)}
	{@render surfacingRegions.cardHead?.(pin)}
	{@render markLabel(pin)}
{/snippet}
{#snippet markFoot(pin: SurfacePin)}
	{@render surfacingRegions.cardFoot?.(pin)}
	<SurfacingMarkActions {pin} {feedback} canSave={!!sessionId} />
{/snippet}
{#snippet markWhy(pin: SurfacePin)}
	{@render surfacingRegions.why?.(pin)}
	<SurfacingMarkWhy {pin} {feedback} categorySet={surfacingConfig.categorySet} />
{/snippet}
{#snippet markBelow(view: ReturnType<typeof surfaceTurn>, cite: (partId: string | null) => void)}
	{@render surfacingRegions.belowStrip?.(view, cite)}
	{#if feedback.toast}
		<div role="status" class="mark-toast" data-testid="surfacing-mark-toast"><span>{feedback.toast.text}</span><Button variant="ghost" size="content" tone="inherit" class="rounded-full px-[10px] h-[24px] max-md:h-[32px] bg-inverse-text/12 font-semibold" data-testid="surfacing-toast-undo" disabled={feedback.saving} onclick={() => feedback.undo()}>Undo</Button></div>
	{/if}
	{#if feedback.error && !feedback.pending}<p role="alert" class="mt-[6px] text-[12px] text-error">{feedback.error}</p>{/if}
{/snippet}

<div bind:this={panelEl} role={surfacingActive ? "group" : undefined} aria-label={surfacingActive ? "Turn activity" : undefined} onkeydown={surfacingActive ? surfaceCommand : undefined} class="turn-activity max-w-[820px] mx-auto px-[14px] md:px-[32px] mt-[6px] mb-[14px]">
	<AssistantHeader message={segment.reply[0]} {sessionId} {forkMessageId} {model} {providerId} createdAt={segment.reply.length > 0 ? undefined : segment.activity[0]?.createdAt} />
	<div class="md:ml-[42px]">
		<!-- The active turn is a keyboard navigation group; inactive turns add no tab stop. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div role={surfacingActive ? "group" : undefined} tabindex={surfacingActive ? 0 : undefined} aria-label={surfacingActive ? "Turn messages" : undefined} onkeydown={surfacingActive ? surfaceCommand : undefined} data-testid={surfacingActive ? "surfacing-card" : undefined} class="turn-head-card @container rounded-[14px] bg-turn-bg px-[12px] pt-[10px] pb-[2px] md:pb-[9px]">
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
				{#if surfacingActive}
					<div class="surface-head-chips" data-surfacing-region="head-chips">
						{#if surface.openAsk}<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget class="shrink-0 h-[24px] rounded-full px-[9px] font-mono text-[12px] font-medium bg-status-ask/18 text-status-ask" data-testid="surfacing-ask-chip" onclick={() => revealMessage(surface.openAsk)}>? #{surface.openAsk.surfacingOrdinal}</Button>{/if}
						{#if surface.hasReadState}<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget class="shrink-0 h-[24px] rounded-full px-[9px] font-mono text-[12px] font-medium {surface.unreadCount ? 'bg-accent/18 text-accent' : 'bg-chip text-text-secondary'}" data-testid="surfacing-head-unread" onclick={() => revealMessage(surface.nextUnread?.part ?? null)}>{surface.unreadCount ? `${surface.unreadCount} unread` : "All read ✓"}</Button>{/if}
						{@render surfacingRegions.headChips?.(surface)}
					</div>
				{/if}
				{#if onsummarize}<span class="hidden md:contents"><Button variant="accent-soft" size="content" touchTarget class="rounded-full px-[10px] py-[4px] text-[12px] shrink-0" onclick={onsummarize}>✦ Summarize</Button></span>{/if}
			</div>
			{#if surfacingActive}
				<SurfacingCard view={surface} {live} {level} overridden={override !== undefined} regions={{ ...surfacingRegions, cardHead: markHead, cardFoot: markFoot, why: markWhy, belowStrip: markBelow }}
					startTime={surfaceTime((segment.activity[0]?.createdAt ?? turn.user?.createdAt ?? 0) - (turn.user?.createdAt ?? segment.activity[0]?.createdAt ?? 0))}
					endTime={surfaceTime(duration ?? 0)} onpick={pick} onlevel={selectLevel}
					ondefault={async () => { if (sessionId) await makeSurfaceDefault(sessionId, level); }}
					onreset={() => { if (sessionId) setSessionSurfaceLevel(sessionId, null); picked = null; folded = false; }}
					onfold={foldMessage} onfollow={followLatest} oncommand={surfaceCommand} onjump={surfaceJump} onhover={surfaceHover}>
					{#snippet strip()}
						<ActivityStrip {turn} {segment} {final} {now} {running} active={hovered} emphasis={skillSteps} interactive={false} />
					{/snippet}
				</SurfacingCard>
			{:else}
			<div class="md:mt-[7px]">
				<ActivityStrip {turn} {segment} {final} {now} {running} active={hovered} emphasis={skillSteps}
					onhover={(index) => { hovered = index; detailsOpen = index !== null; }} onjump={jumpTo} />
			</div>
			{/if}
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
						<ActivityRow {part} {liveTasks} {taskListedAt} live={latestLiveStep} duration={durations?.[i]} highlight={part.uuid === focusUuid} messageNumber={part.type === "assistant" ? surfacingActive ? part.surfacingOrdinal : messageNumber(i) : undefined} />
						{#if surfacingActive && expanded && part.type === "assistant"}
							{@const pin = surface.messages.find((message) => message.part.uuid === part.uuid)}
							{#if pin}
								{@const place = `surfacing-step-mark-${pin.number ?? pin.part.uuid}`}
								<div data-testid={place} class="mb-[8px] ml-[20px]">
									<div class="flex flex-wrap items-center gap-[4px]">
										<Button variant="ghost" size="content" tone="muted" class="h-[26px] max-md:h-[32px] px-[6px] rounded-full text-[12px]" ariaLabel={`Open message #${pin.number ?? "?"}`} data-testid="surfacing-step-open-{pin.number}" onclick={() => { if (level === "final") selectLevel("all"); pick(pin); }}>#{pin.number ?? "?"} ↗</Button>
										{@render markLabel(pin)}
										<SurfacingMarkActions {pin} {feedback} {place} canSave={!!sessionId} />
									</div>
									<SurfacingMarkWhy {pin} {feedback} {place} categorySet={surfacingConfig.categorySet} />
								</div>
							{/if}
						{/if}
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

<style>
	.surface-head-chips { display:contents; }
	.mark-toast { display:flex; align-items:center; gap:10px; width:fit-content; max-width:100%; min-height:34px; margin:10px auto 2px; padding:4px 5px 4px 14px; border-radius:999px; background:var(--color-inverse-bg); color:var(--color-inverse-text); font-size:13px; box-shadow:0 8px 24px rgb(0 0 0 / .22); }
</style>
