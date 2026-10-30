<script module lang="ts">
	import type { Snippet } from "svelte";
	import type { SurfacePart, SurfacePin } from "../../utils/surface-turn.js";

	export type Gesture =
		| { kind: "idle"; hovered: string | null }
		| { kind: "pressed"; id: string; x: number; y: number }
		| { kind: "dragging"; id: string };
	export type Markers =
		| { kind: "plain" }
		| { kind: "dots"; mode: "collapsed" | "tab"; dots: readonly SurfacePin[] }
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
	import { onDestroy, tick } from "svelte";
	import { suppressFollowupClick } from "../../actions/click-on-lift.js";
	import { surfacePinRows, type SurfacePinGroup } from "../../utils/surface-turn.js";
	import { MARK_GLYPHS } from "../../stores/surfacing-feedback.svelte.js";
	import Button from "./Button.svelte";
	import Surface from "./Surface.svelte";
	import Icon from "./Icon.svelte";
	import { FLOATING_ELEVATION_CLASSES } from "./floating-styles.js";

	let { segments, seams = [], handBacks = [], width = $bindable(0), active = null, markers = { kind: "plain" }, cardSlot = { kind: "none" }, card, openAsk = null, belowLevel = false, cited = null, phone = false, preview, stepPreview, sliderText, oninteraction, onpick, onstep, oncommand }: {
		segments: readonly { id: string; left: number; width: number; label: string; tone: keyof typeof TONES; running?: boolean; kind?: "message" | "step" }[];
		seams?: readonly { id: string; left: number; width: number }[];
		handBacks?: readonly { id: string; x: number; label: string }[];
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
		stepPreview?: Snippet<[string]> | undefined;
		sliderText?: string | undefined;
		oninteraction?: ((interaction: StripInteraction) => void) | undefined;
		onpick?: ((pin: SurfacePin) => void) | undefined;
		onstep?: ((id: string) => void) | undefined;
		oncommand?: ((event: KeyboardEvent) => void) | undefined;
	} = $props();
	let gesture = $state<Gesture>({ kind: "idle", hovered: null });
	let cursor = $state<string | null>(null);
	let timelineEl: HTMLDivElement | undefined = $state();
	let trackEl: HTMLDivElement | undefined = $state();
	let stripEl: HTMLDivElement | undefined = $state();
	let laneWidth = $state(0);
	let hoverX = $state(0);
	let hoverHeight = $state(0);
	let layoutVersion = $state(0);
	let lastGroupTap: { source: string; picked: string } | null = null;
	const hovered = $derived(gesture.kind === "idle" ? gesture.hovered : gesture.kind === "dragging" ? gesture.id : null);
	const scrubbing = $derived(gesture.kind !== "idle");
	const pinMarkers = $derived(markers.kind === "pins" ? markers : null);
	const collapsed = $derived(markers.kind === "dots" && markers.mode === "collapsed");
	const groups = $derived(pinMarkers ? surfacePinRows({ pins: pinMarkers.pins, openAsk }, laneWidth, phone) : []);
	const currentGroup = $derived(groups.find((group) => group.members.some((pin) => cardSlot.kind !== "none" && pin.part.uuid === cardSlot.card.part.uuid)));
	const selected = $derived(Math.max(0, segments.findIndex((segment) => segment.id === cursor)));
	const highlighted = $derived(active ?? hovered);
	const messagePreview = $derived(cardSlot.kind === "preview" ? cardSlot.card : null);
	const hoveredStep = $derived(segments.find((step) => step.id === hovered && step.kind !== "message"));
	const anchor = $derived(cardSlot.kind === "none" ? null : `clamp(14px, ${currentGroup?.x ?? cardSlot.card.x}%, calc(100% - 14px))`);
	const hoverPosition = $derived.by(() => {
		void layoutVersion;
		void width;
		if (!stripEl || (!messagePreview && !hoveredStep)) return { top: 0, left: 0, width: 0, caret: "14px", side: "bottom" };
		const box = stripEl.getBoundingClientRect();
		const bounds = stripEl.closest("#messages, [data-session-id]")?.getBoundingClientRect();
		const below = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight) - box.bottom;
		const above = box.top - Math.max(0, bounds?.top ?? 0);
		const flip = below < hoverHeight + 10 && above > below;
		const cardWidth = messagePreview ? box.width : Math.min(560, box.width);
		const x = ((messagePreview ? currentGroup?.x ?? messagePreview.x : hoverX) / 100) * box.width;
		const left = messagePreview ? 0 : Math.max(0, Math.min(box.width - cardWidth, x - cardWidth / 2));
		return {
			top: box.top - (timelineEl?.getBoundingClientRect().top ?? box.top) + (flip ? -hoverHeight - 10 : stripEl.offsetHeight + 10),
			left, width: cardWidth, caret: `clamp(14px, ${x - left}px, calc(100% - 14px))`, side: flip ? "top" : "bottom",
		};
	});
	$effect(() => { oninteraction?.({ hovered, scrubbing }); });
	onDestroy(() => oninteraction?.({ hovered: null, scrubbing: false }));

	function placeHover(node: HTMLDivElement) {
		hoverHeight = node.clientHeight;
		// Apply the measured placement before the card can extend transcript overflow.
		void tick().then(() => {
			node.dataset["positioned"] = "";
		});
	}

	function clear() { gesture = { kind: "idle", hovered: null }; }
	function activateStep(id: string) {
		const pin = markers.kind === "dots" ? markers.dots.find((pin) => pin.part.uuid === id) : undefined;
		if (pin) onpick?.(pin);
		else onstep?.(id);
	}
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
		let question = (event.target as Element).closest<HTMLElement>("[data-hand-back]");
		if (question && stripEl) {
			// Overlapping transparent targets belong to the nearest face, with
			// ties going left, rather than whichever button paints last.
			let distance = Infinity;
			for (const candidate of stripEl.querySelectorAll<HTMLElement>("[data-hand-back]")) {
				const box = candidate.getBoundingClientRect();
				const next = Math.abs(event.clientX - (box.left + box.width / 2));
				if (next < distance) { question = candidate; distance = next; }
			}
			const box = question.getBoundingClientRect();
			// The hit extension must still let a painted work band open its row.
			if (distance > box.width / 2 + 1 && Math.abs(event.clientY - (box.top + box.height / 2)) <= 2) question = null;
		}
		const id = question?.dataset["handBack"] ?? (event.target as Element).closest<HTMLElement>("[data-surface-part]")?.dataset["surfacePart"] ?? stepAt(xAt(event.clientX))?.id;
		if (!id) return;
		// Suppress touch's later mouse-focus default; the reveal owns focus.
		// Vertical scrolling still belongs to touch-action: pan-y.
		if (event.pointerType === "touch") event.preventDefault();
		gesture = { kind: "pressed", id, x: event.clientX, y: event.clientY };
		// Synthetic events have no browser pointer to capture.
		if (event.isTrusted) trackEl.setPointerCapture(event.pointerId);
	}
	function pointerMove(event: PointerEvent) {
		const x = xAt(event.clientX);
		hoverX = x;
		const stepId = stepAt(x)?.id;
		if (gesture.kind === "pressed" && (Math.abs(event.clientX - gesture.x) < 4 || Math.abs(event.clientX - gesture.x) <= Math.abs(event.clientY - gesture.y))) return;
		if (gesture.kind !== "idle") {
			const id = markers.kind === "pins" ? nearest(markers.pins, x)?.part.uuid : stepId;
			if (id) { lastGroupTap = null; gesture = { kind: "dragging", id }; }
		} else if (event.pointerType === "mouse") {
			const pinId = (event.target as Element).closest<HTMLElement>("[data-hover-id]")?.dataset["hoverId"];
			gesture = { kind: "idle", hovered: pinId ?? (markers.kind !== "pins" || (event.target as Element).closest(".surface-strip") ? stepId ?? null : null) };
		}
	}
	function pointerUp(event: PointerEvent) {
		if (gesture.kind === "idle") return;
		suppressFollowupClick(event);
		const previous = gesture;
		clear();
		if (trackEl?.hasPointerCapture(event.pointerId)) trackEl.releasePointerCapture(event.pointerId);
		if (previous.kind === "pressed" && handBacks.some((pin) => pin.id === previous.id)) { onstep?.(previous.id); return; }
		if (markers.kind === "pins") {
			if (previous.kind === "dragging") { const pin = markers.pins.find((pin) => pin.part.uuid === previous.id); if (pin) onpick?.(pin); }
			else { const group = groups.find((group) => group.leader.part.uuid === previous.id); if (group) pickGroup(group); else onstep?.(stepAt(xAt(event.clientX))?.id ?? previous.id); }
		} else { cursor = stepAt(xAt(event.clientX))?.id ?? previous.id; activateStep(cursor); }
	}
	function keyboard(event: KeyboardEvent) {
		const button = (event.target as Element).closest<HTMLButtonElement>("button[data-surface-part], button[data-step-id], button[data-hand-back]");
		if (button) {
			const buttons = [...trackEl?.querySelectorAll<HTMLButtonElement>(button.hasAttribute("data-hand-back") ? ".surface-strip button[data-hand-back]" : button.hasAttribute("data-step-id") ? ".surface-strip button[data-step-id]" : ".pin-lane button[data-surface-part]") ?? []];
			const index = buttons.indexOf(button);
			let next: number;
			switch (event.key) {
				case "ArrowLeft": case "ArrowUp": next = Math.max(0, index - 1); break;
				case "ArrowRight": case "ArrowDown": next = Math.min(buttons.length - 1, index + 1); break;
				case "Home": next = 0; break;
				case "End": next = buttons.length - 1; break;
				case "Enter": case " ": clear(); if (!button.hasAttribute("data-hand-back")) oncommand?.(event); event.stopPropagation(); return;
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
		activateStep(step.id);
	}
</script>

<svelte:window onresize={() => layoutVersion++} onscrollcapture={() => layoutVersion++} onkeydowncapture={(event) => { if (event.key === "Escape" && hovered) { clear(); event.preventDefault(); event.stopPropagation(); } }} />

<div bind:this={timelineEl} class="timeline" class:minimised-turn={collapsed} onpointerleave={() => { if (gesture.kind === "idle") clear(); }} role="group" aria-label={collapsed ? "Minimised turn messages" : "Turn strip"}>
	<div bind:this={trackEl} bind:clientWidth={width} class:dots={markers.kind === "dots"} class={collapsed ? "minimised-scrub" : pinMarkers ? "surfacing-scrub select-none" : "relative h-[44px] md:h-[16px] min-w-[44px] cursor-pointer touch-pan-y select-none outline-none focus-visible:ring-1 focus-visible:ring-accent"}
		data-testid={collapsed ? "surfacing-minimised-strip" : pinMarkers ? "surfacing-scrub" : undefined}
		data-surfacing-region={pinMarkers ? "strip-overlay" : undefined}
		role="slider" tabindex="0" aria-label={pinMarkers ? "Surfaced messages" : `Activity timeline — ${segments.length} steps`}
		aria-valuemin={0} aria-valuemax={Math.max(0, pinMarkers ? pinMarkers.pins.length - 1 : segments.length - 1)}
		aria-valuenow={pinMarkers ? Math.max(0, pinMarkers.pins.findIndex((pin) => pin.part.uuid === pinMarkers.selected)) : selected}
		aria-valuetext={pinMarkers ? sliderText : segments[selected]?.label ?? "No activity"} aria-disabled={segments.length === 0}
		onkeydown={keyboard} onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={clear} onlostpointercapture={clear}
		onfocus={() => { if (markers.kind !== "pins" && gesture.kind === "idle") { const step = segments[selected]; hoverX = step ? step.left + step.width / 2 : 0; gesture = { kind: "idle", hovered: step?.id ?? null }; } }} onblur={() => { if (gesture.kind === "idle") clear(); }}>
		{#if pinMarkers}
		<div class="pin-lane" class:two-rows={groups.some((group) => group.row === 1)} class:empty={pinMarkers.pins.length === 0} data-testid="surfacing-pins" bind:clientWidth={laneWidth} data-layout-ready={laneWidth > 0} data-lane-width={laneWidth}>
		{#each groups as group (group.leader.part.uuid)}
			{@const pin = group.members.find((member) => member.part.uuid === pinMarkers?.selected) ?? group.leader}
			{@const current = pinMarkers?.selected === pin.part.uuid}
			{@const isCited = group.members.some((member) => member.part.uuid === cited)}
			{@const unread = group.members.some((member) => member.read === false && !member.pending && member.part.uuid !== pinMarkers?.selected && member.part.uuid !== openAsk?.uuid)}
			<Button variant="ghost" size="content" hoverFill="none" class="absolute h-[32px] rounded-full {group.row ? 'bottom-[24px]' : 'bottom-0'}" style="left:{group.left}px;width:{group.width}px;--pin-tick:{group.tick}px" data-x={group.x} data-surface-part={group.leader.part.uuid} data-hover-id={pin.part.uuid} data-testid={group.members.length > 1 ? "surfacing-group" : `surfacing-pin-${pin.number ?? `pending-${pin.part.uuid}`}`} data-row={group.row} data-group-members={group.members.map((member) => member.number ?? "pending").join(",")} data-group-leader={group.leader.number} data-cited={isCited} ariaLabel={group.members.length > 1 ? `Group of ${group.members.length}, led by #${group.leader.number} ${group.leader.label}${current ? `; showing ${pin.name}` : ""}` : pin.name} aria-pressed={current} onclick={(event) => { if (event.detail === 0) { clear(); pickGroup(group); } }}>
				<span class="pin-chip" class:builtin={!!pin.builtinCategory} class:current class:cited={isCited} class:open-ask={openAsk?.uuid === pin.part.uuid} class:pending={pin.pending} class:below={belowLevel && pinMarkers?.selected === pin.part.uuid} style:--surface-colour={pin.colour} data-number={pin.number} data-category={pin.category}><span class="glyph">{pin.glyph}</span><span class="pin-number" class:hidden={phone}>{pin.number ?? ""}</span>{#if pin.part.surfacingMark}<sup class="mark-glyph {pin.part.surfacingMark.direction ?? 'raise'}">{MARK_GLYPHS[pin.part.surfacingMark.direction ?? "raise"]}</sup>{/if}{#if group.members.length > 1}<small>+{group.members.length - 1}</small>{/if}{#if unread}<i class="unread-dot"></i>{/if}</span>
			</Button>
		{/each}
		</div>
		{/if}
		<div class={collapsed ? "thin-track surface-strip" : pinMarkers ? "surface-strip relative h-[16px] min-w-[44px]" : "surface-strip absolute inset-0"} data-testid={collapsed ? "surfacing-thin-track" : undefined} role={pinMarkers ? "group" : undefined} aria-label={pinMarkers ? `Activity timeline — ${segments.length} steps` : undefined} bind:this={stripEl}>
			{#if segments.length === 0}<div class="absolute top-1/2 inset-x-0 h-[4px] -translate-y-1/2 rounded-[2px] bg-chip" aria-hidden="true" data-testid="strip-empty-track"></div>{/if}
			{#each segments as segment (segment.id)}
				<Button variant="ghost" size="content" hoverFill="none" ariaLabel={segment.label} data-step-id={segment.id} class="absolute top-1/2 h-[4px] -translate-y-1/2 rounded-[1px] transition-opacity {TONES[segment.tone]} {segment.running ? 'live-segment' : ''} opacity-100" data-active={highlighted === segment.id} style="left:{segment.left}%;width:{segment.width}%;" onclick={(event) => { if (event.detail === 0) { cursor = segment.id; clear(); activateStep(segment.id); } }}><span class="sr-only">{segment.label}</span></Button>
			{/each}
			{#each seams as seam (seam.id)}
				<span data-step-id={seam.id} aria-hidden="true" class="absolute top-1/2 h-[10px] w-[2px] -translate-y-1/2 bg-text-secondary" style:left="{seam.left}%"></span>
			{/each}
			{#each handBacks as pin, index (pin.id)}
				<Button variant="ghost" size="content" hoverFill="none" class="hand-back absolute top-1/2 z-[var(--z-raised)] flex size-[12px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-turn-bg font-mono text-[10px] leading-none text-status-ask ring-1 ring-status-ask pointer-events-auto" style="left:clamp(7px, {pin.x}%, calc(100% - 7px))" data-hand-back={pin.id} data-testid="turn-hand-back-pin" ariaLabel={`Q&A ${index + 1}: ${pin.label}`} onclick={(event) => { if (event.detail === 0) { clear(); onstep?.(pin.id); } }}>?</Button>
			{/each}
						{#if pinMarkers && anchor}<i class="surface-thumb" style:left={anchor}></i>{/if}
		{#if hovered && (hoveredStep && stepPreview || messagePreview && !pinMarkers)}<i data-testid="strip-hover-marker" class="strip-hover-marker" style:left="{hoverX}%"><Icon name="chevron-down" size={10} class="absolute top-full left-1/2 -translate-x-1/2" /></i>{/if}
		</div>
		{#if markers.kind === "dots"}
			{#each markers.dots as pin (pin.part.uuid)}
				<span class="unread-dot" class:read={pin.read === true} class:ask={pin.part.uuid === openAsk?.uuid} style:--surface-colour={pin.colour ?? "var(--color-text-dimmer)"} style:left="{pin.x}%" data-testid={pin.part.uuid === openAsk?.uuid ? "surfacing-minimised-ask" : pin.read === true ? "surfacing-minimised-read" : "surfacing-minimised-unread"} aria-hidden="true"></span>
			{/each}
			
		{/if}
	</div>
	{#if pinMarkers?.selected && card && cardSlot.kind !== "none"}
		<div class="hanging-card {cardSlot.kind === 'preview' ? 'opacity-0 pointer-events-none' : ''}" class:ask={cardSlot.card.category === "ask" && !cardSlot.card.pending}>
			{#if cardSlot.kind === "selected"}<i class="card-caret" style:left={anchor}></i>{/if}
			{@render card()}
		</div>
	{/if}
	{#if hoveredStep && stepPreview}
		<div role="group" aria-label="Step preview" class="hanging-card hover-card z-[var(--z-popover)] {FLOATING_ELEVATION_CLASSES}" {@attach placeHover} bind:clientHeight={hoverHeight} style="top:{hoverPosition.top}px;left:{hoverPosition.left}px;width:{hoverPosition.width}px" data-side={hoverPosition.side} onpointerup={(event) => { suppressFollowupClick(event); const id = hoveredStep.id; clear(); activateStep(id); }}>
			<i class="card-caret" style="left:{hoverPosition.caret};--card-background:var(--color-bg-alt)"></i>
			<Surface variant="raised" radius="lg" padding="md" data-testid="turn-step-popover">{@render stepPreview(hoveredStep.id)}</Surface>
		</div>
	{/if}
	{#if messagePreview && preview}
		<div role="group" aria-label="Hover preview" class="hanging-card hover-card z-[var(--z-popover)] {FLOATING_ELEVATION_CLASSES}" {@attach placeHover} bind:clientHeight={hoverHeight} style="top:{hoverPosition.top}px;left:{hoverPosition.left}px;width:{hoverPosition.width}px" class:ask={messagePreview.category === "ask" && !messagePreview.pending} data-side={hoverPosition.side} data-testid="surfacing-minimised-peek" data-ordinal={messagePreview.number}
			onpointerup={(event) => { suppressFollowupClick(event); const pin = messagePreview; clear(); if (pin) onpick?.(pin); }}>
			<i class="card-caret" style:left={hoverPosition.caret}></i>
			{@render preview(messagePreview)}
		</div>
	{/if}
</div>

<style>
	.surface-strip :global(.hand-back)::before { content:""; position:absolute; inset:-6px; }
	/* Keep the 24px target below the painted chips in the pin lane. */
	.pin-lane + .surface-strip :global(.hand-back)::before { top:0; bottom:-12px; }
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
	.pin-chip.current { color:var(--color-text); background:color-mix(in srgb,var(--surface-colour,var(--color-text-secondary)) 22%,var(--color-turn-bg)); box-shadow:inset 0 0 0 1px var(--surface-colour,var(--color-text-secondary)); }
	.cited { translate:0 -4px; box-shadow:0 0 0 1.5px var(--color-accent),0 4px 10px rgba(var(--shadow-rgb),.2); }
	.open-ask { background:color-mix(in srgb,var(--color-status-ask) 14%,var(--color-turn-bg)); box-shadow:inset 0 0 0 1px var(--color-status-ask); }
	.pending { background:none; outline:1px dashed var(--color-accent); outline-offset:-1px; color:var(--color-accent); }
	.below { outline:1px dashed var(--color-text); outline-offset:-1px; }
	.unread-dot { position:absolute; top:-2px; right:-2px; width:7px; height:7px; border-radius:50%; background:var(--color-accent); box-shadow:0 0 0 1.5px var(--color-turn-bg); }
	.hanging-card { position:relative; margin-top:10px; --card-background:var(--color-bg); }
	/* Design E tints an Ask card's outline, not its fill. */
	.hanging-card.ask { --card-border:color-mix(in srgb,var(--color-status-ask) 65%,var(--color-bg)); }
	.hover-card { position:absolute; margin-top:0; }
	.hover-card:not([data-positioned]) { position:fixed; visibility:hidden; }
	.hover-card::before { content:""; position:absolute; bottom:100%; left:0; right:0; height:10px; }
	.hover-card[data-side="top"]::before { bottom:auto; top:100%; }
	.hover-card[data-side="top"] .card-caret { top:auto; bottom:-6px; transform:translateX(-50%) rotate(225deg); }
	.card-caret { position:absolute; top:-6px; width:12px; height:12px; background:var(--card-background); border-top:1px solid var(--card-border,var(--color-border)); border-left:1px solid var(--card-border,var(--color-border)); transform:translateX(-50%) rotate(45deg); }
	.surface-thumb { position:absolute; top:50%; width:3px; height:14px; border-radius:2px; background:var(--color-text); transform:translate(-50%,-50%); pointer-events:none; }
	.surface-strip :global(.live-segment) { animation:strip-breathe 1.2s ease-in-out infinite; }
	@keyframes strip-breathe { 50% { opacity:.35; } }
	@media(prefers-reduced-motion:reduce) { .surface-strip :global(.live-segment) { animation:none; } }
	.timeline { position:relative; }
	.strip-hover-marker { position:absolute; top:50%; width:2px; height:18px; transform:translate(-50%,-50%); background:var(--color-text); color:var(--color-text); pointer-events:none; }
	.minimised-scrub { position:relative; display:block; width:100%; padding:6px 0; border-radius:4px; }
	.minimised-scrub:focus-visible { outline:2px solid var(--color-accent); outline-offset:2px; }
	.thin-track { height:4px; pointer-events:none; }
	.dots .unread-dot { position:absolute; top:50%; width:7px; height:7px; border-radius:50%; background:var(--surface-colour,var(--color-accent)); transform:translate(-50%, -50%); box-shadow:0 0 0 1.5px var(--color-turn-bg); }
	.dots .unread-dot.read { border:1px solid var(--surface-colour); background:var(--color-turn-bg); }
	.dots .unread-dot.ask::after { content:""; position:absolute; inset:-4px; border:1px solid var(--color-status-ask); border-radius:50%; opacity:.55; }
	/* The ring hugs the 4px track, as on desktop, so it clears the peek card measured from the track. */
	@media (max-width:767px) { .minimised-scrub { padding:20px 0; } .minimised-scrub:focus-visible { outline-offset:-14px; } }

</style>
