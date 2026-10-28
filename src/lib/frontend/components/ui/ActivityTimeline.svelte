<script module lang="ts">
	import type { Snippet } from "svelte";
	import type { SurfacePart, SurfacePin } from "../../utils/surface-turn.js";

	export type Gesture =
		| { kind: "idle"; hovered: string | null }
		| { kind: "pressed"; id: string; x: number; y: number }
		| { kind: "dragging"; id: string };
	export type Markers =
		| { kind: "dots"; dots: readonly SurfacePin[] }
		| { kind: "pins"; pins: SurfacePin[]; selected: string | null };
	export type StripInteraction = { hovered: string | null; scrubbing: boolean };
	export type CardSlot = { kind: "none" } | { kind: "selected"; card: SurfacePin } | { kind: "preview"; card: SurfacePin };
	const TONES = {
		explore: "bg-act-explore", edit: "bg-seg-edit", shell: "bg-act-shell",
		fetch: "bg-act-fetch", task: "bg-act-task", other: "bg-act-other",
		thinking: "bg-act-thinking", text: "bg-act-text", fail: "bg-seg-fail",
		compaction: "bg-text", live: "bg-accent",
	} as const;
</script>

<script lang="ts">
	import { onDestroy } from "svelte";
	import { surfacePinRows, type SurfacePinGroup } from "../../utils/surface-turn.js";
	import { MARK_GLYPHS } from "../../stores/surfacing-feedback.svelte.js";
	import Button from "./Button.svelte";
	import { FLOATING_ELEVATION_CLASSES } from "./floating-styles.js";

	let { segments, seams = [], width = $bindable(0), active = null, markers = { kind: "dots", dots: [] }, cardSlot = { kind: "none" }, card, openAsk = null, belowLevel = false, cited = null, phone = false, preview, sliderText, oninteraction, onpick, onjump, oncommand }: {
		segments: readonly { id: string; left: number; width: number; label: string; tone: keyof typeof TONES; running?: boolean }[];
		seams?: readonly { id: string; left: number; width: number }[];
		width?: number;
		active?: string | null;
		markers?: Markers | undefined;
		cardSlot?: CardSlot | undefined;
		card?: Snippet | undefined;
		openAsk?: SurfacePart | null | undefined;
		belowLevel?: boolean | undefined;
		cited?: string | null | undefined;
		phone?: boolean | undefined;
		preview?: Snippet<[SurfacePin]> | undefined;
		sliderText?: string | undefined;
		oninteraction?: ((interaction: StripInteraction) => void) | undefined;
		onpick?: ((pin: SurfacePin) => void) | undefined;
		onjump?: ((id: string) => void) | undefined;
		oncommand?: ((event: KeyboardEvent) => void) | undefined;
	} = $props();
	let gesture = $state<Gesture>({ kind: "idle", hovered: null });
	let cursor = $state<string | null>(null);
	let trackEl: HTMLDivElement | undefined = $state();
	let stripEl: HTMLDivElement | undefined = $state();
	let laneWidth = $state(0);
	let lastGroupTap: { source: string; picked: string } | null = null;
	const hovered = $derived(gesture.kind === "idle" ? gesture.hovered : gesture.kind === "dragging" ? gesture.id : null);
	const scrubbing = $derived(gesture.kind !== "idle");
	const collapsed = $derived(markers.kind === "dots" && preview !== undefined);
	const groups = $derived(markers.kind === "pins" ? surfacePinRows({ pins: markers.pins, openAsk }, laneWidth, phone) : []);
	const currentGroup = $derived(groups.find((group) => group.members.some((pin) => markers.kind === "pins" && pin.part.uuid === markers.selected)));
	const selected = $derived(Math.max(0, segments.findIndex((segment) => segment.id === cursor)));
	const highlighted = $derived(active ?? hovered);
	const messagePreview = $derived(cardSlot.kind === "preview" ? cardSlot.card : null);
	const anchor = $derived(cardSlot.kind === "none" ? null : `clamp(14px, ${currentGroup?.x ?? cardSlot.card.x}%, calc(100% - 14px))`);
	const previewPosition = $derived.by(() => {
		if (!messagePreview || !trackEl) return { left: 0, caret: 0, above: false };
		const box = trackEl.getBoundingClientRect();
		const bottom = trackEl.closest("[data-session-id]")?.getBoundingClientRect().bottom ?? window.innerHeight;
		const dot = messagePreview.x / 100 * box.width;
		const left = Math.max(0, Math.min(box.width - Math.min(400, box.width), dot - Math.min(400, box.width) * 0.7));
		return { left, caret: dot - left, above: bottom - box.bottom < 64 };
	});
	$effect(() => { oninteraction?.({ hovered, scrubbing }); });
	onDestroy(() => oninteraction?.({ hovered: null, scrubbing: false }));

	function clear() { gesture = { kind: "idle", hovered: null }; }
	function xAt(clientX: number): number {
		const rect = stripEl?.getBoundingClientRect();
		return rect?.width ? Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100)) : 0;
	}
	function stepAt(x: number) {
		return segments.find((segment) => x <= segment.left + segment.width) ?? segments.at(-1);
	}
	function nearest(pins: readonly SurfacePin[], x: number): SurfacePin | null {
		return pins.reduce<SurfacePin | null>((best, pin) => !best || Math.abs(pin.x - x) < Math.abs(best.x - x) ? pin : best, null);
	}
	function pickGroup(group: SurfacePinGroup) {
		const previous = lastGroupTap;
		const index = previous?.source === group.leader.part.uuid && markers.kind === "pins" && previous.picked === markers.selected
			? group.members.findIndex((pin) => pin.part.uuid === previous.picked) : -1;
		const target = index >= 0 ? group.members[(index + 1) % group.members.length] ?? group.leader : group.leader;
		lastGroupTap = group.members.length > 1 ? { source: group.leader.part.uuid, picked: target.part.uuid } : null;
		onpick?.(target);
	}
	function pointerDown(event: PointerEvent) {
		if (event.button !== 0 || !event.isPrimary || !trackEl) return;
		const id = (event.target as Element).closest<HTMLElement>("[data-surface-part]")?.dataset["surfacePart"] ?? stepAt(xAt(event.clientX))?.id;
		if (!id) return;
		gesture = { kind: "pressed", id, x: event.clientX, y: event.clientY };
		// Synthetic events have no browser pointer to capture.
		if (event.isTrusted) trackEl.setPointerCapture(event.pointerId);
	}
	function pointerMove(event: PointerEvent) {
		const x = xAt(event.clientX);
		const stepId = collapsed && markers.kind === "dots" ? nearest(markers.dots, x)?.part.uuid : stepAt(x)?.id;
		if (gesture.kind === "pressed" && (Math.abs(event.clientX - gesture.x) < 4 || Math.abs(event.clientX - gesture.x) <= Math.abs(event.clientY - gesture.y))) return;
		if (gesture.kind !== "idle") {
			const id = markers.kind === "pins" ? nearest(markers.pins, x)?.part.uuid : stepId;
			if (id) { lastGroupTap = null; gesture = { kind: "dragging", id }; }
		} else if (event.pointerType === "mouse") {
			// Pin-lane hover never captions a work step.
			gesture = { kind: "idle", hovered: collapsed || (event.target as Element).closest(".surface-strip") ? stepId ?? null : null };
		}
	}
	function pointerUp(event: PointerEvent) {
		if (gesture.kind === "idle") return;
		const previous = gesture;
		clear();
		if (trackEl?.hasPointerCapture(event.pointerId)) trackEl.releasePointerCapture(event.pointerId);
		if (markers.kind === "pins") {
			if (previous.kind === "dragging") { const pin = markers.pins.find((pin) => pin.part.uuid === previous.id); if (pin) onpick?.(pin); }
			else { const group = groups.find((group) => group.leader.part.uuid === previous.id); if (group) pickGroup(group); else onjump?.(stepAt(xAt(event.clientX))?.id ?? previous.id); }
		} else if (collapsed) {
			const pin = nearest(markers.dots, xAt(event.clientX));
			if (pin) onpick?.(pin);
		} else { cursor = stepAt(xAt(event.clientX))?.id ?? previous.id; onjump?.(cursor); }
	}
	function keyboard(event: KeyboardEvent) {
		const button = (event.target as Element).closest<HTMLButtonElement>("button[data-surface-part], button[data-step-id]");
		if (button) {
			const buttons = [...trackEl?.querySelectorAll<HTMLButtonElement>(button.hasAttribute("data-step-id") ? ".surface-strip button[data-step-id]" : ".pin-lane button[data-surface-part]") ?? []];
			const index = buttons.indexOf(button);
			let next: number;
			switch (event.key) {
				case "ArrowLeft": case "ArrowUp": next = Math.max(0, index - 1); break;
				case "ArrowRight": case "ArrowDown": next = Math.min(buttons.length - 1, index + 1); break;
				case "Home": next = 0; break;
				case "End": next = buttons.length - 1; break;
				case "Enter": case " ": clear(); oncommand?.(event); event.stopPropagation(); return;
				default: if (oncommand) { clear(); oncommand(event); } return;
			}
			event.preventDefault(); event.stopPropagation(); clear();
			buttons[next]?.focus({ preventScroll: true });
			return;
		}
		if (oncommand) { clear(); oncommand(event); return; }
		let index: number;
		switch (event.key) {
			case "ArrowLeft": index = Math.max(0, selected - 1); break;
			case "ArrowRight": index = Math.min(segments.length - 1, selected + 1); break;
			case "Home": index = 0; break;
			case "End": index = segments.length - 1; break;
			case "Enter": case " ": index = selected; break;
			case "Escape": clear(); return;
			default: return;
		}
		event.preventDefault(); event.stopPropagation();
		const step = segments[index];
		if (!step) return;
		cursor = step.id; clear();
		if (collapsed && markers.kind === "dots") { const pin = nearest(markers.dots, step.left + step.width / 2); if (pin) onpick?.(pin); }
		else onjump?.(step.id);
	}
</script>

<div class={collapsed ? "minimised-turn" : ""} onpointerleave={() => { if (gesture.kind === "idle") clear(); }} role="group" aria-label={collapsed ? "Minimised turn messages" : "Turn strip"}>
	<div bind:this={trackEl} bind:clientWidth={width} class:dots={markers.kind === "dots"} class={collapsed ? "minimised-scrub" : markers.kind === "pins" ? "surfacing-scrub select-none" : "relative h-[44px] md:h-[16px] min-w-[44px] cursor-pointer touch-pan-y select-none outline-none focus-visible:ring-1 focus-visible:ring-accent"}
		data-testid={collapsed ? "surfacing-minimised-strip" : markers.kind === "pins" ? "surfacing-scrub" : undefined}
		data-surfacing-region={markers.kind === "pins" ? "strip-overlay" : undefined}
		role="slider" tabindex="0" aria-label={markers.kind === "pins" ? "Surfaced messages" : `Activity timeline — ${segments.length} steps`}
		aria-valuemin={0} aria-valuemax={Math.max(0, markers.kind === "pins" ? markers.pins.length - 1 : segments.length - 1)}
		aria-valuenow={markers.kind === "pins" ? Math.max(0, markers.pins.findIndex((pin) => pin.part.uuid === markers.selected)) : selected}
		aria-valuetext={markers.kind === "pins" ? sliderText : segments[selected]?.label ?? "No activity"} aria-disabled={segments.length === 0}
		onkeydown={keyboard} onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={clear} onlostpointercapture={clear}
		onfocus={() => { if (markers.kind === "dots" && gesture.kind === "idle") { const step = segments[selected]; gesture = { kind: "idle", hovered: collapsed && step ? nearest(markers.dots, step.left + step.width / 2)?.part.uuid ?? null : step?.id ?? null }; } }} onblur={() => { if (gesture.kind === "idle") clear(); }}>
		{#if markers.kind === "pins"}
		<div class="pin-lane" class:two-rows={groups.some((group) => group.row === 1)} class:empty={markers.pins.length === 0} data-testid="surfacing-pins" bind:clientWidth={laneWidth} data-layout-ready={laneWidth > 0} data-lane-width={laneWidth}>
		{#each groups as group (group.leader.part.uuid)}
			{@const pin = group.members.find((member) => member.part.uuid === (markers.kind === "pins" ? markers.selected : null)) ?? group.leader}
			{@const current = markers.kind === "pins" && markers.selected === pin.part.uuid}
			{@const isCited = group.members.some((member) => member.part.uuid === cited)}
			{@const unread = group.members.some((member) => member.read === false && !member.pending && member.part.uuid !== (markers.kind === "pins" ? markers.selected : null) && member.part.uuid !== openAsk?.uuid)}
			<Button variant="ghost" size="content" hoverFill="none" class="absolute h-[32px] rounded-full {group.row ? 'bottom-[24px]' : 'bottom-0'}" style="left:{group.left}px;width:{group.width}px;--pin-tick:{group.tick}px" data-x={group.x} data-surface-part={group.leader.part.uuid} data-testid={group.members.length > 1 ? "surfacing-group" : `surfacing-pin-${pin.number ?? `pending-${pin.part.uuid}`}`} data-row={group.row} data-group-members={group.members.map((member) => member.number ?? "pending").join(",")} data-group-leader={group.leader.number} data-cited={isCited} ariaLabel={group.members.length > 1 ? `Group of ${group.members.length}, led by #${group.leader.number} ${group.leader.label}${current ? `; showing ${pin.name}` : ""}` : pin.name} aria-pressed={current} onclick={(event) => { if (event.detail === 0) { clear(); pickGroup(group); } }}>
				<span class="pin-chip" class:builtin={!!pin.builtinCategory} class:current class:cited={isCited} class:open-ask={openAsk?.uuid === pin.part.uuid} class:pending={pin.pending} class:below={belowLevel && markers.kind === "pins" && markers.selected === pin.part.uuid} style:--surface-colour={pin.colour} data-number={pin.number} data-category={pin.category}><span class="glyph">{pin.glyph}</span><span class="pin-number" class:hidden={phone}>{pin.number ?? ""}</span>{#if pin.part.surfacingMark}<sup class="mark-glyph {pin.part.surfacingMark.direction ?? 'raise'}">{MARK_GLYPHS[pin.part.surfacingMark.direction ?? "raise"]}</sup>{/if}{#if group.members.length > 1 && !phone}<small>+{group.members.length - 1}</small>{/if}{#if unread}<i class="unread-dot"></i>{/if}</span>
			</Button>
		{/each}
		</div>
		{/if}
		<div class={collapsed ? "thin-track surface-strip" : markers.kind === "pins" ? "surface-strip relative h-[16px] min-w-[44px]" : "surface-strip absolute inset-0"} data-testid={collapsed ? "surfacing-thin-track" : undefined} role={markers.kind === "pins" ? "group" : undefined} aria-label={markers.kind === "pins" ? `Activity timeline — ${segments.length} steps` : undefined} bind:this={stripEl}>
			{#each segments as segment (segment.id)}
				<Button variant="ghost" size="content" hoverFill="none" ariaLabel={segment.label} data-step-id={segment.id} class="absolute top-1/2 h-[4px] -translate-y-1/2 rounded-[1px] transition-opacity {TONES[segment.tone]} {segment.running ? 'live-segment' : ''} opacity-100" data-active={highlighted === segment.id} style="left:{segment.left}%;width:{segment.width}%;" onclick={(event) => { if (event.detail === 0) { cursor = segment.id; clear(); if (collapsed && markers.kind === "dots") { const pin = nearest(markers.dots, segment.left + segment.width / 2); if (pin) onpick?.(pin); } else onjump?.(segment.id); } }}><span class="sr-only">{segment.label}</span></Button>
			{/each}
			{#each seams as seam (seam.id)}
				<span data-step-id={seam.id} aria-hidden="true" class="absolute top-1/2 h-[10px] w-[2px] -translate-y-1/2 bg-text-secondary" style:left="{seam.left}%"></span>
			{/each}
			{#if markers.kind === "pins" && anchor}<i class="surface-thumb" style:left={anchor}></i>{/if}
		</div>
		{#if markers.kind === "dots"}
			{#each markers.dots as pin (pin.part.uuid)}
				<span class="unread-dot" class:read={pin.read === true} class:ask={pin.part.uuid === openAsk?.uuid} style:--surface-colour={pin.colour ?? "var(--color-text-dimmer)"} style:left="{pin.x}%" data-testid={pin.part.uuid === openAsk?.uuid ? "surfacing-minimised-ask" : pin.read === true ? "surfacing-minimised-read" : "surfacing-minimised-unread"} aria-hidden="true"></span>
			{/each}
			{#if messagePreview}<span class="unread-dot peek-dot" class:ask={messagePreview.part.uuid === openAsk?.uuid} style:left="{messagePreview.x}%" aria-hidden="true"></span>{/if}
		{/if}
	</div>
	{#if cardSlot.kind === "selected" && card}
		<div class="hanging-card" class:ask={cardSlot.card.category === "ask" && !cardSlot.card.pending}>
			<i class="card-caret" style:left={anchor}></i>
			{@render card()}
		</div>
	{/if}
	{#if messagePreview && preview}
		<div role="group" aria-label="Hover preview" class="hanging-card hover-card z-[var(--z-popover)] {FLOATING_ELEVATION_CLASSES}" class:ask={messagePreview.category === "ask" && !messagePreview.pending} data-side={previewPosition.above ? "top" : "bottom"} data-testid="surfacing-minimised-peek" data-ordinal={messagePreview.number}
			onpointerup={() => { const pin = messagePreview; clear(); if (pin) onpick?.(pin); }}>
			<i class="card-caret" style:left={anchor}></i>
			{@render preview(messagePreview)}
		</div>
	{/if}
</div>

<style>
	.surfacing-scrub { position:relative; margin-top:9px; touch-action:pan-y; outline:none; }
	.surfacing-scrub:focus-visible { outline:1px solid var(--color-accent); border-radius:6px; }
	/* Ticks paint behind every pill, so an upper row's long tick never strikes through a lower pill. */
	.pin-lane { position:relative; height:25px; isolation:isolate; }
	.pin-lane.two-rows { height:49px; }
	.pin-lane.empty { height:8px; }
	.pin-lane + .surface-strip { margin-top:-8px; }
	.pin-chip { position:relative; display:inline-flex; align-items:center; justify-content:center; gap:3px; flex:none; min-width:100%; box-sizing:border-box; height:19px; padding:0 6px; border-radius:999px; background:var(--color-chip); font:500 11px var(--font-mono); color:var(--color-text-secondary); white-space:nowrap; }
	.pin-chip::after { content:""; position:absolute; top:100%; left:var(--pin-tick,50%); width:1px; height:6px; background:var(--color-border); pointer-events:none; z-index:-1; }
	.pin-chip small { margin-left:1px; font-size:10px; color:var(--color-text-muted); }
	.glyph { color:var(--surface-colour,var(--color-text-dimmer)); }
	.mark-glyph { align-self:flex-start; margin:3px 0 0 1px; font-size:9px; line-height:1; }
	.mark-glyph.raise { color:var(--color-success); } .mark-glyph.lower { color:var(--color-text-muted); } .mark-glyph.retype { color:var(--color-accent); }
	.pin-chip.current { background:color-mix(in srgb,var(--surface-colour,var(--color-text-secondary)) 14%,var(--color-turn-bg)); box-shadow:inset 0 0 0 1px var(--surface-colour,var(--color-text-secondary)); }
	.cited { translate:0 -4px; box-shadow:0 0 0 1.5px var(--color-accent),0 4px 10px rgba(var(--shadow-rgb),.2); }
	.open-ask { background:color-mix(in srgb,var(--color-status-ask) 14%,var(--color-turn-bg)); box-shadow:inset 0 0 0 1px var(--color-status-ask); }
	.pending { background:none; outline:1px dashed var(--color-accent); outline-offset:-1px; color:var(--color-accent); }
	.below { outline:1px dashed var(--color-text); outline-offset:-1px; }
	.unread-dot { position:absolute; top:-2px; right:-2px; width:7px; height:7px; border-radius:50%; background:var(--color-accent); box-shadow:0 0 0 1.5px var(--color-turn-bg); }
	.hanging-card { position:relative; margin-top:10px; --card-background:var(--color-bg); }
	.hanging-card.ask { --card-background:color-mix(in srgb,var(--color-status-ask) 14%,var(--color-turn-bg)); }
	.hover-card { position:absolute; top:100%; left:0; right:0; }
	.hover-card[data-side="top"] { top:auto; bottom:calc(100% + 10px); }
	.card-caret { position:absolute; top:-6px; width:12px; height:12px; background:var(--card-background); border-top:1px solid var(--color-border); border-left:1px solid var(--color-border); transform:translateX(-50%) rotate(45deg); }
	.surface-thumb { position:absolute; top:50%; width:3px; height:14px; border-radius:2px; background:var(--color-text); transform:translate(-50%,-50%); pointer-events:none; }
	.surface-strip :global(.live-segment) { animation:strip-breathe 1.2s ease-in-out infinite; }
	@keyframes strip-breathe { 50% { opacity:.35; } }
	@media(prefers-reduced-motion:reduce) { .surface-strip :global(.live-segment) { animation:none; } }
	.minimised-turn { position:relative; }
	.minimised-scrub { position:relative; display:block; width:100%; padding:6px 0; border-radius:4px; }
	.minimised-scrub:focus-visible, :global(.peek:focus-visible) { outline:2px solid var(--color-accent); outline-offset:2px; }
	.thin-track { height:4px; pointer-events:none; }
	.dots .unread-dot { position:absolute; top:50%; width:7px; height:7px; border-radius:50%; background:var(--surface-colour,var(--color-accent)); transform:translate(-50%, -50%); box-shadow:0 0 0 1.5px var(--color-turn-bg); }
	.dots .unread-dot.read { border:1px solid var(--surface-colour); background:var(--color-turn-bg); }
	.dots .unread-dot.ask::after { content:""; position:absolute; inset:-4px; border:1px solid var(--color-status-ask); border-radius:50%; opacity:.55; }
	.dots .peek-dot { width:11px; height:11px; box-shadow:0 0 0 2px var(--color-turn-bg), 0 0 0 3.5px var(--color-accent); }
	.dots .peek-dot.ask { box-shadow:0 0 0 2px var(--color-turn-bg), 0 0 0 3.5px var(--color-status-ask); }
	.dots .peek-dot.ask::after { content:none; }
	.minimised-turn :global(.peek) { position:absolute; z-index:10; top:calc(100% + 10px); display:flex; align-items:center; gap:8px; width:min(400px, 100%); padding:8px 12px; border-radius:10px; background:var(--color-popover-bg); color:var(--color-text); box-shadow:0 0 0 1px var(--color-border), var(--shadow-dropdown); font-size:13px; white-space:nowrap; text-align:left; }
	.minimised-turn :global(.peek::before) { content:""; position:absolute; top:-6px; left:calc(var(--caret) - 6px); width:12px; height:12px; background:var(--color-popover-bg); box-shadow:-1px -1px 0 var(--color-border); transform:rotate(45deg); }
	.minimised-turn :global(.peek-above) { top:auto; bottom:calc(100% + 10px); }
	.minimised-turn :global(.peek-above::before) { top:auto; bottom:-6px; box-shadow:1px 1px 0 var(--color-border); }



	@media (max-width:767px) { .minimised-scrub { padding:20px 0; } .minimised-turn :global(.peek) { min-height:44px; } }

</style>
