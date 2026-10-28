<script lang="ts">
	import type { Snippet } from "svelte";
	import type { SurfacePin } from "../../utils/surface-turn.js";
	let { strip }: { strip: Snippet<[Snippet<[SurfacePin]>]> } = $props();
</script>

{#snippet preview(pin: SurfacePin)}
	<span style:color={pin.colour ?? "var(--color-text-dimmer)"}>{pin.glyph}</span><b>#{pin.number ?? "?"}</b><span class="peek-text">{pin.part.rawText.replace(/\s+/g, " ")}</span><small>Click to open</small>
{/snippet}
{@render strip(preview)}

<style>
	b, small { flex:none; }
	.peek-text { min-width:0; overflow:hidden; text-overflow:ellipsis; color:var(--color-text-secondary); }
	small { margin-left:auto; color:var(--color-text-muted); font-size:12px; }
</style>
