<script lang="ts">
	import type { Snippet } from "svelte";
	import type { SurfacePin, SurfaceTurn } from "../../utils/surface-turn.js";
	import Button from "../ui/Button.svelte";

	let { view, strip, onopen }: { view: SurfaceTurn; strip: Snippet; onopen: (pin: SurfacePin) => void } = $props();
	let peek = $state<SurfacePin | null>(null);
	// The peek sits under its dot, 70% along like the drawing, clamped inside the turn; the caret marks the dot.
	let peekLeft = $state(0);
	let caretLeft = $state(0);
	let peekAbove = $state(false);
	let stripEl = $state<HTMLButtonElement | HTMLAnchorElement>();
	function nearest(clientX: number): SurfacePin | null {
		const box = stripEl?.getBoundingClientRect();
		if (!box) return null;
		const x = box.width ? Math.max(0, Math.min(100, (clientX - box.left) / box.width * 100)) : 0;
		return view.messages.reduce<SurfacePin | null>((best, pin) => !best || Math.abs(pin.x - x) < Math.abs(best.x - x) ? pin : best, null);
	}
	function showPeek(pin: SurfacePin | null) {
		const box = stripEl?.getBoundingClientRect();
		const bottom = stripEl?.closest("[data-session-id]")?.getBoundingClientRect().bottom ?? window.innerHeight;
		peekAbove = !!box && bottom - box.bottom < 64;
		if (box && pin) {
			const width = Math.min(400, box.width);
			const dot = pin.x / 100 * box.width;
			peekLeft = Math.max(0, Math.min(box.width - width, dot - width * 0.7));
			caretLeft = dot - peekLeft;
		}
		peek = pin;
	}
</script>

<div class="minimised-turn" role="group" aria-label="Minimised turn messages" onpointerleave={(event) => { if (event.pointerType === "mouse") peek = null; }}>
	<Button bind:element={stripEl} variant="ghost" size="content" tone="inherit" hoverFill="none" class="minimised-scrub" data-testid="surfacing-minimised-strip" ariaLabel="Peek at turn messages" aria-expanded={peek !== null}
		onpointermove={(event) => { if (event.pointerType === "mouse") showPeek(nearest(event.clientX)); }}
		onfocus={() => { if (!peek) showPeek(view.messages[0] ?? null); }}
		onkeydown={(event) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); peek = null; }
		}}
		onclick={(event) => {
			const pin = event.detail === 0 ? peek ?? view.messages[0] : nearest(event.clientX);
			if (pin) onopen(pin);
		}}>
		<div class="thin-track" data-testid="surfacing-thin-track">{@render strip()}</div>
		{#each view.messages.filter((pin) => pin.read === false || pin.part.uuid === view.openAsk?.uuid) as pin (pin.part.uuid)}
			<span class="unread-dot" class:ask={pin.part.uuid === view.openAsk?.uuid} style:left="{pin.x}%" data-testid={pin.part.uuid === view.openAsk?.uuid ? "surfacing-minimised-ask" : "surfacing-minimised-unread"} aria-hidden="true"></span>
		{/each}
		{#if peek}<span class="unread-dot peek-dot" class:ask={peek.part.uuid === view.openAsk?.uuid} style:left="{peek.x}%" aria-hidden="true"></span>{/if}
	</Button>
	{#if peek}
		<Button variant="ghost" size="content" tone="inherit" hoverFill="none" class="peek {peekAbove ? 'peek-above' : ''}" style="left:{peekLeft}px; --caret:{caretLeft}px" data-testid="surfacing-minimised-peek" data-ordinal={peek.number} onclick={() => { if (peek) onopen(peek); }}>
			<span style:color={peek.colour}>{peek.glyph}</span><b>#{peek.number ?? "?"}</b><span class="peek-text">{peek.part.rawText.replace(/\s+/g, " ")}</span><small>Click to open</small>
		</Button>
	{/if}
</div>

<style>
	.minimised-turn { position:relative; }
	.minimised-turn :global(.minimised-scrub) { position:relative; display:block; width:100%; padding:6px 0; border-radius:4px; }
	.minimised-turn :global(.minimised-scrub:focus-visible), .minimised-turn :global(.peek:focus-visible) { outline:2px solid var(--color-accent); outline-offset:2px; }
	.thin-track { height:4px; overflow:hidden; pointer-events:none; }
	.thin-track :global(> div) { height:4px; }
	.unread-dot { position:absolute; top:50%; width:7px; height:7px; border-radius:50%; background:var(--color-accent); transform:translate(-50%, -50%); box-shadow:0 0 0 1.5px var(--color-turn-bg); }
	.unread-dot.ask { background:var(--color-status-ask); }
	.unread-dot.ask::after { content:""; position:absolute; inset:-4px; border:1px solid var(--color-status-ask); border-radius:50%; opacity:.55; }
	.peek-dot { width:11px; height:11px; box-shadow:0 0 0 2px var(--color-turn-bg), 0 0 0 3.5px var(--color-accent); }
	.peek-dot.ask { box-shadow:0 0 0 2px var(--color-turn-bg), 0 0 0 3.5px var(--color-status-ask); }
	.peek-dot.ask::after { content:none; }
	.minimised-turn :global(.peek) { position:absolute; z-index:10; top:calc(100% + 10px); display:flex; align-items:center; gap:8px; width:min(400px, 100%); padding:8px 12px; border-radius:10px; background:var(--color-popover-bg); color:var(--color-text); box-shadow:0 0 0 1px var(--color-border), var(--shadow-dropdown); font-size:13px; white-space:nowrap; text-align:left; }
	.minimised-turn :global(.peek::before) { content:""; position:absolute; top:-6px; left:calc(var(--caret) - 6px); width:12px; height:12px; background:var(--color-popover-bg); box-shadow:-1px -1px 0 var(--color-border); transform:rotate(45deg); }
	.minimised-turn :global(.peek-above) { top:auto; bottom:calc(100% + 10px); }
	.minimised-turn :global(.peek-above::before) { top:auto; bottom:-6px; box-shadow:1px 1px 0 var(--color-border); }
	.minimised-turn :global(.peek b), .minimised-turn :global(.peek small) { flex:none; }
	.peek-text { min-width:0; overflow:hidden; text-overflow:ellipsis; color:var(--color-text-secondary); }
	.minimised-turn :global(.peek small) { margin-left:auto; color:var(--color-text-muted); font-size:12px; }
	@media (max-width:599px) { .minimised-turn :global(.minimised-scrub) { padding:20px 0; } .minimised-turn :global(.peek) { min-height:44px; } }
</style>
