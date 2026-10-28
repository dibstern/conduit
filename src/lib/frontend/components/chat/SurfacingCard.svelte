<script module lang="ts">
	import type { Snippet } from "svelte";
	import type { SurfacePin, SurfaceTurn } from "../../utils/surface-turn.js";

	export type ReadState =
		| { kind: "idle" }
		| { kind: "saving"; uuid: string }
		| { kind: "failed"; uuid: string; message: string };

	/** Owned by the annotation, reply, recap and density tickets. */
	export interface SurfacingRegions {
		headChips?: Snippet<[SurfaceTurn]>;
		cardHead?: Snippet<[SurfacePin]>;
		cardFoot?: Snippet<[SurfacePin]>;
		cardContext?: Snippet<[SurfacePin]>;
		why?: Snippet<[SurfacePin]>;
		/** Report the citation's part UUID while its footnote is hovered or focused. */
		belowStrip?: Snippet<[SurfaceTurn, (partId: string | null) => void]>;
	}
</script>

<script lang="ts">
	import { STOPS, type StopCounts } from "../../utils/turn-stops.js";
	import { type SurfaceLevel } from "../../utils/surface-turn.js";
	import Button from "../ui/Button.svelte";
	import SurfacingReplyActions from "./SurfacingReplyActions.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
	import { landTurnTarget, type PendingReveal } from "../../stores/turn-panel.svelte.js";

	let { view, card, counts, live, regions = {}, strip, onpick, onlevel, onfold, onfollow, oncommand, onread, onmarkread, readState = { kind: "idle" }, cardEl = $bindable(), markReadInAxis = false, onreply, replied = false, pending = null, onland = () => {}, scrubbing = false }: {
		scrubbing?: boolean;
		pending?: PendingReveal | null;
		onland?: (seq: number) => void;
		view: SurfaceTurn;
		card: SurfacePin | null;
		counts: StopCounts;
		live: boolean;
		regions?: SurfacingRegions;
		strip: Snippet<[string | null, Snippet]>;
		onpick: (pin: SurfacePin) => void;
		onlevel: (level: SurfaceLevel) => void;
		onfold: () => void;
		onfollow: () => void;
		oncommand: (event: KeyboardEvent) => void;
		onread?: (pin: SurfacePin, read: boolean) => void;
		onmarkread?: () => void;
		readState?: ReadState;
		cardEl?: HTMLElement | undefined;
		markReadInAxis?: boolean;
		onreply?: (pin: SurfacePin, excerpt?: string) => void;
		/** The draft already holds a whole-message reply to this card. */
		replied?: boolean;
	} = $props();
	let citedPart = $state<string | null>(null);
	let cardBodyEl: HTMLDivElement | undefined = $state();
	// With summaries off, the notes line carries the turn's bulk read.
	const markCount = $derived(markReadInAxis && onmarkread ? view.unreadPartIds.length : 0);
</script>

{#snippet stepButton(label: string, glyph: string, onclick: () => void, disabled = false)}
	<Button variant="ghost" size="content" tone="muted" touchTarget {disabled} class="size-[26px] max-md:size-[30px] rounded-full text-[14px]" ariaLabel={label} {onclick}>{glyph}</Button>
{/snippet}

{#snippet messageCard()}
{#if card}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<section bind:this={cardEl} use:landTurnTarget={{ pending, target: { kind: "message", uuid: card.part.uuid }, ack: onland, navigation: scrubbing ? "in-place" : "scroll" }} class="surfacing-msg-card" class:ask={card.category === "ask" && !card.pending} style:--surface-colour={card.colour} style:--category-tint={card.builtinCategory ? "14%" : undefined} data-testid="surfacing-msg-card" data-part={card.part.uuid} data-ordinal={card.number} aria-label={card.name} tabindex="-1" onkeydown={oncommand}>
		<div class="card-head" data-surfacing-region="card-head">
			<span class="type-label"><span class="glyph">{card.glyph}</span> {card.label}</span>
			{#if live && view.following}<span class="following">Following latest</span>{/if}
			{#if view.openAsk?.uuid === card.part.uuid}<span class="needs-reply">Needs reply</span>{/if}
			{@render regions.cardHead?.(card)}
			<span class="card-at">{card.number === undefined ? "Waiting for Jev" : `#${card.number}`}<span class="desktop-time">{` · ${card.time}`}</span>{` · ${view.cardIndex + 1}/${view.pins.length}`}</span>
			{#if card.read !== undefined && onread}<label class="read-toggle"><Checkbox data-testid="surfacing-read-toggle" bind:checked={() => card.read === true, (read) => onread?.(card, read)} onchange={(event) => { event.currentTarget.checked = card.read === true; }} disabled={readState.kind === "saving"} class="size-[15px] rounded-[4px]" />Read</label>{/if}
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
{/snippet}

{@render strip(citedPart, messageCard)}

{#if view.level === "final" || view.empty || view.notJudgedCount || markCount || (live && !view.following)}
<div class="axis-notes" data-testid="surfacing-notes">
	{#if view.level === "final"}<span>{STOPS.final.menu} · {counts.all} hidden</span>{/if}
	{#if view.empty}<span>Nothing at {STOPS[view.level].short} · <Button variant="ghost-accent" size="content" hoverFill="none" touchTarget class="font-mono" onclick={() => onlevel("all")}>Show {STOPS.all.short}</Button></span>{/if}
	{#if view.notJudgedCount}<span data-testid="surfacing-not-judged">⚠ {view.notJudgedCount} not judged</span>{/if}
	{#if markCount}<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget class="h-[22px] shrink-0 rounded-full px-[8px] font-sans text-[11.5px] font-medium bg-accent/15 text-accent" disabled={readState.kind === "saving"} data-testid="surfacing-mark-read" onclick={() => onmarkread?.()}>✓ Mark {markCount} read</Button>{/if}
	{#if live && !view.following}<Button variant="ghost-accent" size="content" hoverFill="none" touchTarget class="font-mono" ariaLabel="Follow latest" onclick={onfollow}>now ⇥</Button>{/if}
</div>
{/if}
{#if readState.kind === "failed" && (!card || readState.uuid === card.part.uuid)}<p role="alert" class="mt-[4px] text-[12px] text-error">{readState.message}</p>{/if}
<div data-surfacing-region="below-strip">{@render regions.belowStrip?.(view, (partId) => { citedPart = partId; })}</div>

<style>
	.surfacing-msg-card { padding:10px 12px 8px; border:1px solid var(--color-border); border-radius:12px; background:var(--card-background,var(--color-bg)); outline:none; }
	.surfacing-msg-card.ask { padding:11px 13px 12px; }
	.ask .card-body { margin-top:6px; font-size:14px; line-height:1.55; }
	.card-head { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
	.type-label,.needs-reply { padding:2px 7px; border-radius:999px; font-size:11px; font-weight:600; background:color-mix(in srgb,var(--surface-colour,var(--color-text-dimmer)) var(--category-tint,16%),transparent); color:var(--surface-colour,var(--color-text)); }
	.needs-reply { color:var(--color-status-ask); background:color-mix(in srgb,var(--color-status-ask) 16%,transparent); }
	.following { font-size:11px; color:var(--color-text-secondary); }
	.card-at { margin-left:auto; font:11.5px var(--font-mono); color:var(--color-text-muted); white-space:nowrap; }
	.read-toggle { display:inline-flex; align-items:center; gap:5px; min-height:32px; font-size:12px; color:var(--color-text-muted); cursor:pointer; }
	.card-note { margin-top:6px; font-size:12px; color:var(--color-text-muted); }
	.card-body { margin-top:7px; font-size:14px; line-height:1.6; overflow-wrap:anywhere; }
	.card-body :global(p:last-child) { margin-bottom:0; }
	.card-foot { display:flex; align-items:center; gap:4px; margin-top:9px; }
	.grow { flex:1; }
	.axis-notes { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; margin-top:4px; color:var(--color-text-dimmer); font:11.5px var(--font-mono); }
	@media(max-width:767px) {
		.card-body { font-size:15px; }
		.desktop-time { display:none; }
	}
</style>
