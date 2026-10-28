<script lang="ts">
	import ConduitMark from "./ConduitMark.svelte";

	let {
		size = "standard",
		animated = false,
		showText = true,
		hits,
		class: className = "",
	}: {
		size?: "standard" | "loading" | "sidebar" | "inline";
		animated?: boolean;
		showText?: boolean;
		/** Hands the mark to an outside effect (the connect overlay's rain), which replaces the ripple. */
		hits?: number;
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

<div class="conduit-logo flex flex-col items-center {className}">
	<div data-flow-hero class="hero" style:--mark-size={`${config.markSize}px`}>
		{#if hits === undefined}<span data-flow-ripple class:rippling={animated}></span>{/if}
		<ConduitMark size={config.markSize} {animated} {hits} />
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
	@keyframes ripple { from { transform: scale(1); opacity: .7; } to { transform: scale(1.55); opacity: 0; } }
	@media (prefers-reduced-motion: reduce) { .rippling { animation: none; } }
</style>
