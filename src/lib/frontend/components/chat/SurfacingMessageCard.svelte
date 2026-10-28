<script module lang="ts">
	import type { Snippet } from "svelte";
	import type { SurfacePin, SurfaceTurn } from "../../utils/surface-turn.js";
	import type { PendingReveal } from "../../stores/turn-panel.svelte.js";
	import type { ReadState, SurfacingRegions } from "./SurfacingCard.svelte";
	export type Props = { kind: "preview"; card: SurfacePin; onreply?: never; onread?: never; onexplain?: never } | {
		kind: "selected"; card: SurfacePin; view: SurfaceTurn; live: boolean;
		onreply: (pin: SurfacePin, excerpt?: string) => void;
		onread: (pin: SurfacePin, read: boolean) => void;
		onexplain: (pin: SurfacePin) => void;
		regions?: SurfacingRegions; context?: Snippet<[SurfacePin, () => void]> | undefined;
		pending?: PendingReveal | null; onland?: (seq: number) => void;
		scrubbing?: boolean; readState?: ReadState; replied?: boolean;
		oncommand: (event: KeyboardEvent) => void;
		onpick: (pin: SurfacePin) => void; onfold: () => void; onfollow: () => void;
	};
</script>
<script lang="ts">
	import Button from "../ui/Button.svelte";
	import Surface from "../ui/Surface.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
	import SurfacingReplyActions from "./SurfacingReplyActions.svelte";
	import { landTurnTarget } from "../../stores/turn-panel.svelte.js";
	let { cardEl = $bindable(), ...props }: Props & { cardEl?: HTMLElement | undefined } = $props();
	let cardBodyEl: HTMLDivElement | undefined = $state();
	const selected = $derived(props.kind === "selected" ? props : null);
</script>

{#snippet stepButton(label: string, glyph: string, onclick: () => void, disabled = false)}
	<Button variant="ghost" size="content" tone="muted" touchTarget {disabled} class="size-[26px] max-md:size-[30px] rounded-full text-[14px]" ariaLabel={label} {onclick}>{glyph}</Button>
{/snippet}
{#if props.kind === "preview"}
	<Surface variant="bare" radius="none" class="surfacing-msg-card border border-border rounded-[12px] {props.card.category === 'ask' && !props.card.pending ? 'ask' : ''}" style="background:var(--card-background,var(--color-bg));--surface-colour:{props.card.colour};--category-tint:{props.card.builtinCategory ? '14%' : '16%'}" data-testid="surfacing-hover-preview" data-part={props.card.part.uuid} data-ordinal={props.card.number} aria-label={props.card.name}>
		{@render body(props.card)}
	</Surface>
{:else if props.card}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<section bind:this={cardEl} use:landTurnTarget={{ pending: props.pending ?? null, target: { kind: "message", uuid: props.card.part.uuid }, ack: props.onland ?? (() => {}), navigation: props.scrubbing ? "in-place" : "scroll" }} class="surfacing-msg-card border border-border rounded-[12px] outline-none" class:ask={props.card.category === "ask" && !props.card.pending} style:background="var(--card-background,var(--color-bg))" style:--surface-colour={props.card.colour} style:--category-tint={props.card.builtinCategory ? "14%" : undefined} data-testid="surfacing-msg-card" data-part={props.card.part.uuid} data-ordinal={props.card.number} aria-label={props.card.name} tabindex="-1" onkeydown={props.oncommand}>
		{@render body(props.card)}
	</section>
{/if}

{#snippet body(card: SurfacePin)}
	<div class="message-content" class:ask={card.category === "ask" && !card.pending} inert={props.kind === "preview"}>
		<div class="card-head" data-surfacing-region="card-head">
			<span class="type-label"><span class="glyph">{card.glyph}</span> {card.label}</span>
			{#if selected?.live && selected.view.following}<span class="following">Following latest</span>{/if}
			{#if selected?.view.openAsk?.uuid === card.part.uuid}<span class="needs-reply">Needs reply</span>{/if}
			{@render selected?.regions?.cardHead?.(card)}
			<span class="card-at">{card.number === undefined ? "Waiting for Jev" : `#${card.number}`}<span class="desktop-time">{` · ${card.time}`}</span>{selected ? ` · ${selected.view.cardIndex + 1}/${selected.view.pins.length}` : ""}</span>
			{#if card.read !== undefined && selected}<label class="read-toggle"><Checkbox data-testid="surfacing-read-toggle" bind:checked={() => card.read === true, (read) => selected?.onread(card, read)} onchange={(event) => { event.currentTarget.checked = card.read === true; }} disabled={selected?.readState?.kind === "saving"} class="size-[15px] rounded-[4px]" />Read</label>{/if}
		</div>
		{#if selected?.view.cardNote}<div class="card-note">{selected.view.cardNote}</div>{/if}
		<div class="card-body md-content select-text" bind:this={cardBodyEl}>{@html card.part.html}</div>
		{#if selected?.context}{@render selected.context(card, () => selected?.onexplain(card))}{:else}{@render selected?.regions?.cardContext?.(card)}{/if}
		{@render selected?.regions?.why?.(card)}
		<div class="card-foot" data-surfacing-region="card-foot">
		{#if props.kind === "preview"}
			<span class="text-text-muted text-[11.5px]">Hover preview · click to open the turn on this message</span>
		{:else}
			{#if selected}<SurfacingReplyActions source={card.part.uuid} within={cardBodyEl} replied={selected.replied ?? false} disabled={card.number === undefined} onreply={(excerpt) => selected.onreply(card, excerpt)} />{/if}
			{@render selected?.regions?.cardFoot?.(card)}
			<span class="grow"></span>
			{#if selected?.live && !selected.view.following}<Button variant="accent-soft" size="content" touchTarget class="h-[26px] max-md:h-[30px] rounded-full px-[9px] text-[12.5px] font-medium" ariaLabel="Follow latest" onclick={selected?.onfollow}>now ⇥</Button>{/if}
			{@render stepButton("Previous message", "‹", () => { if (selected?.view.previous) selected.onpick(selected.view.previous); }, !selected?.view.previous)}
			{@render stepButton("Next message", "›", () => { if (selected?.view.next) selected.onpick(selected.view.next); }, !selected?.view.next)}
			{@render stepButton(selected?.live ? "Fold message" : "Close message", selected?.live ? "–" : "✕", () => selected?.onfold())}
		{/if}
		</div>
	</div>
{/snippet}


<style>
	.message-content { padding:10px 12px 8px; }
	.message-content.ask { padding:11px 13px 12px; }
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
	@media(max-width:767px) { .card-body { font-size:15px; } .desktop-time { display:none; } }
</style>
