<script lang="ts">
	import ConduitMark from "./ConduitMark.svelte";

	let {
		size = "standard",
		animated = false,
		showText = true,
		class: className = "",
	}: {
		size?: "standard" | "loading" | "sidebar" | "inline";
		animated?: boolean;
		showText?: boolean;
		class?: string;
	} = $props();

	const configs = {
		standard: { textSize: "text-2xl", markSize: 48 },
		loading: { textSize: "text-[28px]", markSize: 96 },
		sidebar: { textSize: "text-[14px]", markSize: 20 },
		inline: { textSize: "text-base", markSize: 16 },
	} as const;
	const config = $derived(configs[size]);
</script>

{#snippet sparkle(x: number, y: number, radius: number, delay: string)}
	<svg x={x - radius} y={y - radius} width={radius * 2} height={radius * 2} viewBox="-7 -7 14 14" overflow="visible">
		<path data-flow-sparkle class:twinkling={animated} style:animation-delay={delay} d="M0-7C1.54-1.54 1.54-1.54 7 0C1.54 1.54 1.54 1.54 0 7C-1.54 1.54-1.54 1.54-7 0C-1.54-1.54-1.54-1.54 0-7Z" fill="currentColor" />
	</svg>
{/snippet}

<div class="conduit-logo flex flex-col items-center {className}">
	<div data-flow-hero class="hero" style:--mark-size={`${config.markSize}px`}>
		<span data-flow-ripple class:rippling={animated}></span>
		<span data-flow-ripple class:rippling={animated} style:animation-delay="-1.2s"></span>
		<ConduitMark size={config.markSize} {animated} />
		<svg class="sparkles" viewBox="0 0 160 160" aria-hidden="true">
			{@render sparkle(20, 34, 7, "0s")}
			{@render sparkle(142, 52, 5, "-0.6s")}
			{@render sparkle(134, 140, 6, "-1.1s")}
		</svg>
	</div>
	{#if showText}
		<span class="font-medium tracking-[0.14em] text-text font-sans {config.textSize}">conduit</span>
	{/if}
</div>

<style>
	.conduit-logo { gap: 6px; }
	.hero { position: relative; display: grid; place-items: center; width: calc(var(--mark-size) * 5 / 3); height: calc(var(--mark-size) * 5 / 3); color: var(--color-accent); }
	[data-flow-ripple] { position: absolute; width: var(--mark-size); height: var(--mark-size); border: 2px solid currentColor; border-radius: calc(var(--mark-size) * .27); opacity: .35; }
	.hero :global([data-conduit-mark]) { position: relative; }
	.rippling { animation: ripple 2.4s ease-out infinite; }
	.sparkles { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
	[data-flow-sparkle] { transform-box: fill-box; transform-origin: center; }
	.twinkling { animation: twinkle 1.8s ease-in-out infinite; }
	@keyframes ripple { from { transform: scale(1); opacity: .7; } to { transform: scale(1.55); opacity: 0; } }
	@keyframes twinkle { 0%, 100% { transform: scale(.35); opacity: .25; } 50% { transform: scale(1); opacity: 1; } }
	@media (prefers-reduced-motion: reduce) { .rippling, .twinkling { animation: none; } }
</style>
