<script lang="ts">
	import { untrack } from "svelte";

	let {
		size = "sm",
		variant = "brand",
		tone = "accent",
		animated,
		hits,
		"data-testid": testId,
	}: {
		size?: "sm" | "md" | number;
		variant?: "brand" | "running" | "unread" | "idle";
		tone?: "accent" | "goal" | "inherit";
		animated?: boolean;
		/** Brand only: the hook rests dim and fires once each time this increments. */
		hits?: number | undefined;
		"data-testid"?: string;
	} = $props();

	const pixels = $derived(typeof size === "number" ? size : size === "sm" ? 20 : 26);
	const packet = $derived(variant === "running" || (variant === "brand" && animated === true));
	const moving = $derived(animated ?? variant === "running");

	let tile: HTMLSpanElement;
	let pulse = $state<SVGPathElement>();
	// A remounted mark (the overlay returning after a reconnect) must not replay the hit it was born with.
	let firedHits = untrack(() => hits);
	$effect(() => {
		if (hits === firedHits || !pulse) return;
		firedHits = hits;
		// The dash is 100 of a 100-long path; round caps need the extra 10 to hide fully.
		pulse.animate(
			[{ strokeDashoffset: 110 }, { strokeDashoffset: 0, offset: 0.45 }, { strokeDashoffset: 0, offset: 0.6 }, { strokeDashoffset: -110 }],
			{ duration: 800, easing: "cubic-bezier(.65, 0, .35, 1)" },
		);
		tile.animate([{ filter: "brightness(1.35)" }, { filter: "brightness(1)" }], { duration: 640, easing: "ease-out" });
		tile.animate([{ scale: 1 }, { scale: 0.95 }, { scale: 1 }], { duration: 380, easing: "cubic-bezier(.3, 1.5, .5, 1)" });
	});
</script>

{#snippet hook(width: number, opacity = 1, highlight = false)}
	<path
		d="M2 4h5a2 2 0 0 1 0 4H5"
		stroke="currentColor"
		stroke-width={width}
		fill="none"
		stroke-linecap="round"
		{opacity}
		data-flow-packet={highlight ? "" : undefined}
		class:flowing={highlight && moving}
		pathLength={highlight ? 100 : undefined}
		stroke-dasharray={highlight ? "30 100" : undefined}
		stroke-dashoffset={highlight ? -30 : undefined}
	/>
{/snippet}

<span
	bind:this={tile}
	aria-hidden="true"
	data-testid={testId}
	data-conduit-mark
	data-variant={variant}
	data-flow-glyph={variant === "brand" ? undefined : variant}
	class="conduit-mark {variant}"
	class:goal={tone === "goal"}
	class:inherited={tone === "inherit"}
	style:width={`${pixels}px`}
	style:height={`${pixels}px`}
	style:border-radius={variant === "brand" ? `${pixels * 0.27}px` : undefined}
>
	{#if variant === "brand"}
		<svg viewBox="0 0 12 12" width="60%" height="60%">
			{#if hits !== undefined}
				{@render hook(1.8, 0.4)}
				<path bind:this={pulse} d="M2 4h5a2 2 0 0 1 0 4H5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" data-flow-packet pathLength="100" stroke-dasharray="100 200" stroke-dashoffset="110" />
			{:else}
				{@render hook(1.8, packet ? 0.35 : 1)}
				{#if packet}{@render hook(1.8, 1, true)}{/if}
			{/if}
		</svg>
	{:else}
		<svg viewBox="0 0 16 16" width="100%" height="100%">
			{#if variant === "idle"}
				<rect x="2" y="2" width="12" height="12" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.2" />
			{:else}
				<rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill={variant === "unread" ? "var(--color-session-done)" : "currentColor"} opacity={variant === "running" ? 0.16 : 1} />
			{/if}
			<g transform="translate(2.5 2)">
				{@render hook(variant === "idle" ? 1.4 : 1.6, packet ? 0.35 : 1)}
				{#if packet}{@render hook(1.6, 1, true)}{/if}
			</g>
		</svg>
	{/if}
</span>

<style>
	.conduit-mark { display: inline-grid; flex-shrink: 0; place-items: center; }
	.brand { background: var(--color-brand); color: var(--color-white); }
	.running { color: var(--color-accent); }
	.running.goal { color: var(--color-status-goal); }
	.running.inherited { color: inherit; }
	.unread { color: var(--color-white); }
	.idle { color: var(--color-text-dimmer); }
	.flowing { animation: flow 1.4s cubic-bezier(.45, 0, .55, 1) infinite; }
	@keyframes flow { from { stroke-dashoffset: 30; } to { stroke-dashoffset: -100; } }
	@media (prefers-reduced-motion: reduce) { .flowing { animation: none; } }
</style>
