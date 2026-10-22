<script module lang="ts">
	import type { Snippet } from "svelte";
	import type { SurfacePin, SurfaceTurn } from "../../utils/surface-turn.js";

	/** Owned by the annotation, reply, recap and density tickets. */
	export interface SurfacingRegions {
		headChips?: Snippet<[SurfaceTurn]>;
		stripOverlay?: Snippet<[SurfaceTurn, (pin: SurfacePin) => void]>;
		cardHead?: Snippet<[SurfacePin]>;
		cardFoot?: Snippet<[SurfacePin]>;
		cardContext?: Snippet<[SurfacePin]>;
		why?: Snippet<[SurfacePin]>;
		/** Report the citation's part UUID while its footnote is hovered or focused. */
		belowStrip?: Snippet<[SurfaceTurn, (partId: string | null) => void]>;
	}
</script>

<script lang="ts">
	import { untrack } from "svelte";
	import { surfacePinRows, SURFACE_LABELS, SURFACE_LEVELS, type SurfaceLevel, type SurfacePinGroup } from "../../utils/surface-turn.js";
	import Button from "../ui/Button.svelte";
	import SurfacingReplyActions from "./SurfacingReplyActions.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import { MARK_GLYPHS } from "../../stores/surfacing-feedback.svelte.js";

	let { view, live, level, overridden, endTime, startTime, regions = {}, strip, onpick, onlevel, ondefault, onreset, onfold, onfollow, oncommand, onjump, onhover, onread, onautoread, onmarkread, readSaving = false, readError = "", canAutoRead = true, markReadInAxis = false, onreply, replied = false }: {
		view: SurfaceTurn;
		live: boolean;
		level: SurfaceLevel;
		overridden: boolean;
		endTime: string;
		startTime: string;
		regions?: SurfacingRegions;
		strip: Snippet;
		onpick: (pin: SurfacePin) => void;
		onlevel: (level: SurfaceLevel) => void;
		ondefault: () => Promise<void>;
		onreset: () => void;
		onfold: () => void;
		onfollow: () => void;
		oncommand: (event: KeyboardEvent) => void;
		onjump: (x: number) => void;
		onhover: (x: number | null) => void;
		onread?: (pin: SurfacePin, read: boolean) => void;
		onautoread?: (pin: SurfacePin) => void;
		onmarkread?: () => void;
		readSaving?: boolean;
		readError?: string;
		canAutoRead?: boolean;
		markReadInAxis?: boolean;
		onreply?: (pin: SurfacePin, excerpt?: string) => void;
		/** The draft already holds a whole-message reply to this card. */
		replied?: boolean;
	} = $props();
	let scrubEl: HTMLDivElement;
	let laneWidth = $state(0);
	let viewportWidth = $state(1024);
	let citedPart = $state<string | null>(null);
	const groups = $derived(surfacePinRows(view, laneWidth, viewportWidth < 768));
	const currentGroup = $derived(groups.find((group) => group.members.some((pin) => pin.part.uuid === view.card?.part.uuid)));
	let lastGroupTap: { source: string; picked: string } | null = null;
	let cardEl = $state<HTMLElement>();
	let onScreen = $state(false);
	let visible = $state(false);
	let scrubbing = $state(false);
	let menuOpen = $state(false);
	let saving = $state(false);
	let error = $state("");
	let drag: { id: number; x: number; y: number; moved: boolean; pin?: SurfacePin } | null = null;
	let suppressClick = false;
	let cardBodyEl: HTMLDivElement | undefined = $state();
	const levelOptions = $derived(SURFACE_LEVELS.map((value) => ({
		value,
		label: SURFACE_LABELS[value],
		...(value === "balanced" ? { shortLabel: "Bal" } : {}),
		...(value === "final" ? {} : { detail: String(view.counts[value]) }),
	})));
	// With summaries off, the axis carries the turn's bulk read in place of the start time.
	const markCount = $derived(markReadInAxis && onmarkread ? view.unreadPartIds.length : 0);
	// Track scalar values: the live strip's clock must not restart the read timer.
	const readTarget = $derived(view.card?.read === false ? view.card.part.uuid : null);
	const readText = $derived(view.card?.part.rawText ?? "");
	$effect(() => {
		const changed = () => { visible = document.visibilityState === "visible"; };
		changed();
		document.addEventListener("visibilitychange", changed);
		return () => document.removeEventListener("visibilitychange", changed);
	});
	$effect(() => {
		if (!cardEl) { onScreen = false; return; }
		const observer = new IntersectionObserver((entries) => {
			const entry = entries.at(-1);
			onScreen = !!entry?.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
		});
		observer.observe(cardEl);
		return () => observer.disconnect();
	});
	$effect(() => {
		const target = readTarget;
		void readText;
		if (!target || !visible || !onScreen || scrubbing || readSaving || !canAutoRead || !onautoread) return;
		const timer = setTimeout(() => {
			const card = untrack(() => view.card);
			if (card?.part.uuid === target && document.visibilityState === "visible" && onScreen && !scrubbing) onautoread?.(card);
		}, 1000);
		return () => clearTimeout(timer);
	});

	function xAt(clientX: number): number {
		const box = scrubEl.getBoundingClientRect();
		return Math.max(0, Math.min(100, (clientX - box.left) / box.width * 100));
	}
	function pickGroup(group: SurfacePinGroup) {
		if (group.members.length === 1) { lastGroupTap = null; onpick(group.leader); return; }
		const previous = lastGroupTap;
		const index = previous?.source === group.leader.part.uuid && previous.picked === view.card?.part.uuid
			? group.members.findIndex((pin) => pin.part.uuid === previous.picked) : -1;
		const target = index >= 0 ? group.members[(index + 1) % group.members.length] ?? group.leader : group.leader;
		lastGroupTap = { source: group.leader.part.uuid, picked: target.part.uuid };
		onpick(target);
	}
	function pointerDown(event: PointerEvent) {
		if (event.button !== 0 || !event.isPrimary) return;
		scrubbing = true;
		const target = (event.target as HTMLElement).closest<HTMLElement>("[data-surface-part]");
		const pin = view.pins.find(({ part }) => part.uuid === target?.dataset["surfacePart"]);
		drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, ...(pin ? { pin } : {}) };
		suppressClick = false;
		scrubEl.setPointerCapture(event.pointerId);
	}
	function pointerMove(event: PointerEvent) {
		if (!drag || drag.id !== event.pointerId) {
			// The strip captions the head; the pin lane above it does not.
			if (event.pointerType === "mouse") onhover((event.target as Element).closest(".surface-strip") ? xAt(event.clientX) : null);
			return;
		}
		if (Math.abs(event.clientX - drag.x) >= 4 && Math.abs(event.clientX - drag.x) > Math.abs(event.clientY - drag.y)) drag.moved = true;
		if (drag.moved) {
			lastGroupTap = null;
			const nearest = view.nearestPin(xAt(event.clientX));
			if (nearest) onpick(nearest);
		}
	}
	function pointerUp(event: PointerEvent) {
		if (!drag || drag.id !== event.pointerId) return;
		if (drag.moved) {
			const nearest = view.nearestPin(xAt(event.clientX));
			if (nearest) onpick(nearest);
		} else if (drag.pin) {
			const group = groups.find((item) => item.leader.part.uuid === drag?.pin?.part.uuid);
			if (group) pickGroup(group);
		}
		else {
			onjump(xAt(event.clientX));
		}
		suppressClick = true;
		drag = null;
		scrubbing = false;
		if (scrubEl.hasPointerCapture(event.pointerId)) scrubEl.releasePointerCapture(event.pointerId);
	}
	async function makeDefault() {
		saving = true;
		error = "";
		try { await ondefault(); menuOpen = false; }
		catch { error = "Couldn't save the default. Try again."; }
		finally { saving = false; }
	}
</script>

<svelte:window bind:innerWidth={viewportWidth} />

{#snippet stepButton(label: string, glyph: string, onclick: () => void, disabled = false)}
	<Button variant="ghost" size="content" tone="muted" touchTarget {disabled} class="size-[26px] max-md:size-[30px] rounded-full text-[14px]" ariaLabel={label} {onclick}>{glyph}</Button>
{/snippet}

{#if view.card}
	{@const card = view.card}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<section bind:this={cardEl} class="surfacing-msg-card" class:ask={card.category === "ask" && !card.pending} style:--surface-colour={card.colour} data-testid="surfacing-msg-card" data-part={card.part.uuid} data-ordinal={card.number} aria-label={card.name} tabindex="-1" onkeydown={oncommand}>
		<div class="card-head" data-surfacing-region="card-head">
			<span class="type-label"><span class="glyph">{card.glyph}</span> {card.label}</span>
			{#if view.openAsk?.uuid === card.part.uuid}<span class="needs-reply">Needs reply</span>{/if}
			{@render regions.cardHead?.(card)}
			<span class="card-at">{card.number === undefined ? "Waiting for Jev" : `#${card.number}`}<span class="desktop-time">{` · ${card.time}`}</span>{` · ${view.cardIndex + 1}/${view.pins.length}`}</span>
			{#if card.read !== undefined && onread}<label class="read-toggle"><Checkbox data-testid="surfacing-read-toggle" bind:checked={() => card.read === true, (read) => onread?.(card, read)} onchange={(event) => { event.currentTarget.checked = card.read === true; }} disabled={readSaving} class="size-[15px] rounded-[4px]" />Read</label>{/if}
		</div>
		{#if view.cardNote}<div class="card-note">{view.cardNote}</div>{/if}
		<div class="card-body md-content select-text" bind:this={cardBodyEl}>{@html card.part.html}</div>
		{@render regions.cardContext?.(card)}
		{@render regions.why?.(card)}
		<div class="card-foot" data-surfacing-region="card-foot">
			{#if onreply}<SurfacingReplyActions source={card.part.uuid} within={cardBodyEl} {replied} disabled={card.number === undefined} onreply={(excerpt) => onreply(card, excerpt)} />{/if}
			{@render regions.cardFoot?.(card)}
			<span class="grow"></span>
			{#if live && !view.following}<Button variant="accent-soft" size="content" touchTarget class="h-[26px] max-md:h-[30px] rounded-full px-[9px] text-[12.5px] font-medium" ariaLabel="Follow latest" onclick={onfollow}>now ⇥</Button>{/if}
			{@render stepButton("Previous message", "‹", () => { if (view.previous) onpick(view.previous); }, !view.previous)}
			{@render stepButton("Next message", "›", () => { if (view.next) onpick(view.next); }, !view.next)}
			{@render stepButton(live ? "Fold message" : "Close message", live ? "–" : "✕", onfold)}
		</div>
	</section>
{/if}

<div class="surfacing-scrub select-none" data-testid="surfacing-scrub" data-surfacing-region="strip-overlay" bind:this={scrubEl} role="slider" tabindex="0" aria-label="Surfaced messages" aria-valuemin={0} aria-valuemax={Math.max(0, view.pins.length - 1)} aria-valuenow={Math.max(0, view.cardIndex)} aria-valuetext={view.sliderText} onkeydown={oncommand} onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={() => { drag = null; scrubbing = false; suppressClick = true; }} onpointerleave={() => onhover(null)}>
	<div class="pin-lane" class:empty={view.pins.length === 0} data-testid="surfacing-pins" bind:clientWidth={laneWidth} data-layout-ready={laneWidth > 0} data-lane-width={laneWidth}>
		{#if regions.stripOverlay}
			{@render regions.stripOverlay(view, onpick)}
		{:else}
		{#each groups as group (group.leader.part.uuid)}
			{@const pin = group.members.find((member) => member.part.uuid === view.card?.part.uuid) ?? group.leader}
			{@const current = view.card?.part.uuid === pin.part.uuid}
			{@const cited = group.members.some((member) => member.part.uuid === citedPart)}
			{@const seen = group.members.every((member) => member.read === true) && !group.members.some((member) => member.part.uuid === view.openAsk?.uuid)}
			{@const unread = group.members.some((member) => member.read === false && !member.pending && member !== view.card && member.part.uuid !== view.openAsk?.uuid)}
			<Button variant="ghost" size="content" hoverFill="none" class="absolute h-[32px] rounded-full {group.row ? 'bottom-[27px] max-md:bottom-[43px]' : 'bottom-[3px] max-md:bottom-[5px]'}" style="left:{group.left}px;width:{group.width}px;--pin-tick:{group.tick}px" data-x={group.x} data-surface-part={group.leader.part.uuid} data-testid={group.members.length > 1 ? "surfacing-group" : `surfacing-pin-${pin.number ?? `pending-${pin.part.uuid}`}`} data-row={group.row} data-group-members={group.members.map((member) => member.number ?? "pending").join(",")} data-group-leader={group.leader.number} data-cited={cited} ariaLabel={group.members.length > 1 ? `Group of ${group.members.length}, led by #${group.leader.number} ${group.leader.label}${current ? `; showing ${pin.name}` : ""}` : pin.name} aria-pressed={current} onclick={(event) => { if (event.detail === 0 || !suppressClick) pickGroup(group); }}>
				<span class="pin-chip" class:upper={group.row === 1} class:current class:cited class:open-ask={view.openAsk?.uuid === pin.part.uuid} class:pending={pin.pending} class:below={view.belowLevel && view.card === pin} class:seen={seen} style:--surface-colour={pin.colour} data-number={pin.number} data-category={pin.category}><span class="glyph">{pin.glyph}</span>{pin.number ?? ""}{#if pin.part.surfacingMark}<sup class="mark-glyph {pin.part.surfacingMark.direction ?? 'raise'}">{MARK_GLYPHS[pin.part.surfacingMark.direction ?? "raise"]}</sup>{/if}{#if group.members.length > 1}<small>+{group.members.length - 1}</small>{/if}{#if unread}<i class="unread-dot"></i>{/if}</span>
			</Button>
		{/each}
		{/if}
		{#if view.card}<i class="card-caret" style:left="clamp(14px, {currentGroup?.x ?? view.card.x}%, calc(100% - 14px))"></i>{/if}
	</div>
	<div class="surface-strip">
		{@render strip()}
		{#if view.card || live}<i class="surface-thumb" style:left="{currentGroup?.x ?? view.card?.x ?? 100}%"></i>{/if}
	</div>
</div>

<div class="surface-axis">
	{#if !markCount}<span class="axis-start">{startTime}</span>{/if}
	<span class="axis-notes">{#if level === "final"}<span>Final only · {view.counts.all} hidden</span>{/if}{#if view.empty}<span>Nothing at {SURFACE_LABELS[level]} · <Button variant="ghost-accent" size="content" hoverFill="none" touchTarget class="font-mono" onclick={() => onlevel("all")}>Show All</Button></span>{/if}{#if view.notJudgedCount}<span data-testid="surfacing-not-judged">⚠ {view.notJudgedCount} not judged</span>{/if}{#if markCount}<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget class="h-[22px] shrink-0 rounded-full px-[8px] font-sans text-[11.5px] font-medium bg-accent/15 text-accent" disabled={readSaving} data-testid="surfacing-mark-read" onclick={() => onmarkread?.()}>✓ Mark {markCount} read</Button>{/if}</span>
	<span class="grow"></span>
	<div class="contents" data-testid="surfacing-level"><SegmentedControl variant="level" label="Surfacing level" options={levelOptions} bind:value={() => level, onlevel} /></div>
	{#if overridden}<i class="override-dot" data-testid="surfacing-level-default-dot" title="Overrides the default level"></i>{/if}
	<Menu bind:open={menuOpen} side="top" align="end" ariaLabel="Level options">
		{#snippet trigger({ props })}<Button {...props} variant="ghost" size="content" tone="muted" iconOnly icon="ellipsis" iconSize={14} touchTarget class="size-[22px] rounded-full" ariaLabel="Level options" />{/snippet}
		<MenuItem disabled={saving} closeOnSelect={false} onselect={makeDefault}>Make default</MenuItem>
		<MenuItem disabled={!overridden || saving} onselect={onreset}>Back to default</MenuItem>
		{#if error}<p role="alert" class="px-[8px] py-[6px] text-[12px] text-error">{error}</p>{/if}
	</Menu>
	{#if live && !view.following}<Button variant="ghost-accent" size="content" hoverFill="none" touchTarget class="font-mono" ariaLabel="Follow latest" onclick={onfollow}>now ⇥</Button>{:else}<span class:live-end={live}>{endTime}{live ? " now" : ""}</span>{/if}
</div>
{#if readError}<p role="alert" class="mt-[4px] text-[12px] text-error">{readError}</p>{/if}
<div data-surfacing-region="below-strip">{@render regions.belowStrip?.(view, (partId) => { citedPart = partId; })}</div>

<style>
	.surfacing-msg-card { margin-top:9px; padding:10px 12px 8px; border-radius:12px; background:var(--color-bg); outline:none; }
	.surfacing-msg-card.ask { margin-top:10px; padding:11px 13px 12px; box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-status-ask) 40%,transparent); }
	.ask .card-body { margin-top:6px; font-size:14px; line-height:1.55; }
	.card-head { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
	.type-label,.needs-reply { padding:2px 7px; border-radius:999px; font-size:11px; font-weight:600; background:color-mix(in srgb,var(--surface-colour,var(--color-text-dimmer)) 16%,transparent); color:var(--surface-colour,var(--color-text)); }
	.needs-reply { color:var(--color-status-ask); background:color-mix(in srgb,var(--color-status-ask) 16%,transparent); }
	.card-at { margin-left:auto; font:11.5px var(--font-mono); color:var(--color-text-muted); white-space:nowrap; }
	.read-toggle { display:inline-flex; align-items:center; gap:5px; min-height:32px; font-size:12px; color:var(--color-text-muted); cursor:pointer; }
	.card-note { margin-top:6px; font-size:12px; color:var(--color-text-muted); }
	.card-body { margin-top:7px; font-size:14px; line-height:1.6; overflow-wrap:anywhere; }
	.card-body :global(p:last-child) { margin-bottom:0; }
	.card-foot { display:flex; align-items:center; gap:4px; margin-top:9px; }
	.grow { flex:1; }
	.surfacing-scrub { position:relative; touch-action:pan-y; outline:none; }
	.surfacing-scrub:focus-visible { outline:1px solid var(--color-accent); border-radius:6px; }
	/* Ticks paint behind every pill, so an upper row's long tick never strikes through a lower pill. */
	.pin-lane { position:relative; height:64px; isolation:isolate; }
	.pin-lane.empty { height:8px; }
	.pin-chip { position:relative; display:inline-flex; align-items:center; justify-content:center; gap:3px; flex:none; min-width:100%; box-sizing:border-box; height:20px; padding:0 6px; border-radius:999px; background:var(--color-chip); font:500 11px var(--font-mono); color:var(--color-text); white-space:nowrap; }
	.pin-chip::after { content:""; position:absolute; top:100%; left:var(--pin-tick,50%); width:1px; height:13px; background:var(--color-border); pointer-events:none; z-index:-1; }
	.pin-chip.upper::after { height:37px; }
	.pin-chip small { margin-left:1px; font-size:10px; color:var(--color-text-muted); }
	.glyph { color:var(--surface-colour,var(--color-text-dimmer)); }
	.mark-glyph { align-self:flex-start; margin:3px 0 0 1px; font-size:9px; line-height:1; }
	.mark-glyph.raise { color:var(--color-success); } .mark-glyph.lower { color:var(--color-text-muted); } .mark-glyph.retype { color:var(--color-accent); }
	.current { background:var(--surface-colour,var(--color-text)); color:var(--color-bg); }
	.current .glyph,.current small { color:inherit; }
	.cited { translate:0 -4px; box-shadow:0 0 0 1.5px var(--color-accent),0 4px 10px rgba(var(--shadow-rgb),.2); color:var(--color-text); }
	.seen:not(.current) { background:color-mix(in srgb,var(--color-chip) 55%,transparent); color:var(--color-text-dimmer); }
	.seen:not(.current) .glyph { opacity:.7; }
	.open-ask:not(.current) { background:color-mix(in srgb,var(--color-status-ask) 14%,var(--color-turn-bg)); box-shadow:inset 0 0 0 1.5px var(--color-status-ask); color:var(--color-status-ask); }
	.open-ask::before { content:""; position:absolute; inset:-4px; border-radius:999px; box-shadow:0 0 0 1.5px color-mix(in srgb,var(--color-status-ask) 45%,transparent); animation:ask-pulse 1.6s ease-in-out infinite; }
	.pending { background:none; outline:1px dashed var(--color-accent); outline-offset:-1px; color:var(--color-accent); }
	.below { background:var(--color-turn-bg); outline:1px dashed var(--color-text); outline-offset:-1px; color:var(--color-text); }
	.below .glyph { color:var(--color-text-dimmer); }
	.unread-dot { position:absolute; top:-2px; right:-2px; width:7px; height:7px; border-radius:50%; background:var(--color-accent); box-shadow:0 0 0 1.5px var(--color-turn-bg); }
	.card-caret { position:absolute; top:-6px; width:12px; height:12px; background:var(--color-bg); transform:translateX(-50%) rotate(45deg); }
	.surface-strip { position:relative; }
	.surface-thumb { position:absolute; top:50%; width:3px; height:14px; border-radius:2px; background:var(--color-text); transform:translate(-50%,-50%); pointer-events:none; }
	.surface-axis { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; min-height:26px; margin-top:4px; color:var(--color-text-dimmer); font:11.5px var(--font-mono); }
	.axis-notes { display:contents; }
	.override-dot { width:6px; height:6px; border-radius:50%; background:var(--color-accent); }
	.live-end { color:var(--color-accent); }
	@keyframes ask-pulse { 50% { opacity:.45; } }
	@media(prefers-reduced-motion:reduce) { .open-ask::before { animation:none; } }
	@media(max-width:767px) {
		.pin-lane:not(.empty) { height:80px; }
		.card-body { font-size:15px; }
		.axis-start,.desktop-time { display:none; }
		/* Notes take their own row so the controls and end time stay on one. */
		.axis-notes { display:flex; flex-wrap:wrap; gap:6px 8px; flex-basis:100%; }
		.axis-notes:empty { display:none; }
		.pin-chip { font-size:12px; height:24px; padding:0 7px; }
		.pin-chip.upper::after { height:51px; }
	}
</style>
