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
	import SurfacingMessageCard from "./SurfacingMessageCard.svelte";
	import { type PendingReveal } from "../../stores/turn-panel.svelte.js";

	let { view, card, counts, live, regions = {}, strip, onpick, onlevel, onfold, onfollow, oncommand, onmarkread, readState = { kind: "idle" }, cardEl = $bindable(), markReadInAxis = false, onreply = () => {}, onread = () => {}, onexplain = () => {}, context, replied = false, pending = null, onland = () => {}, scrubbing = false }: {
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
		context?: Snippet<[SurfacePin, () => void]>;
		onexplain?: (pin: SurfacePin) => void;
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
	// With summaries off, the notes line carries the turn's bulk read.
	const markCount = $derived(markReadInAxis && onmarkread ? view.unreadPartIds.length : 0);
</script>

{#snippet messageCard()}
	{#if card}
	<SurfacingMessageCard kind="selected" {card} {view} {live} {regions} {context} {pending} {onland} {scrubbing} {readState} bind:cardEl {onreply} {onread} {onexplain} {replied} {oncommand} {onpick} {onfold} {onfollow} />
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
	.axis-notes { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; margin-top:4px; color:var(--color-text-dimmer); font:11.5px var(--font-mono); }
</style>
