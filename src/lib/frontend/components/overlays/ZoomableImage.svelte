<!-- One image the media viewer can zoom. pele zooms an svg, so the image is wrapped in one at its natural size. -->
<script lang="ts">
	import type { Mounted } from "pele/lazy";
	import { loadPele, resetIfZoomed } from "../../utils/diagram-loader.js";

	let { src }: { src: string } = $props();

	type Preload = { status: "ready"; width: number; height: number } | { status: "failed" };
	// Written only by the preload effect; tagged with its src, so a new src reads as loading until it settles.
	let preload = $state<Preload & { src: string }>();
	const image = $derived<Preload | { status: "loading" }>(preload?.src === src ? preload : { status: "loading" });
	let host: HTMLDivElement | undefined = $state();
	// Written only by the zoom effect below; read by resetZoom.
	let zoom: Mounted["zoom"];

	/** The media viewer's Escape: resets a zoomed image, false when there is nothing to reset. */
	export function resetZoom(): boolean {
		return resetIfZoomed(zoom);
	}

	$effect(() => {
		const url = src;
		const probe = new Image();
		let cancelled = false;
		probe.src = url;
		probe.decode().then(
			() => {
				if (!cancelled) preload = { src: url, status: "ready", width: probe.naturalWidth, height: probe.naturalHeight };
			},
			() => {
				if (!cancelled) preload = { src: url, status: "failed" };
			},
		);
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (image.status !== "ready" || !host) return;
		const target = host;
		let cancelled = false;
		// Without pele the image still shows, just without zoom.
		loadPele().then(
			(pele) => {
				if (cancelled) return;
				zoom = pele.enableZoom(target, { always: true });
				target.focus({ preventScroll: true });
			},
			() => {},
		);
		return () => {
			cancelled = true;
			zoom?.destroy();
			zoom = undefined;
		};
	});
</script>

{#if image.status === "failed"}
	<p class="text-white">Image couldn't load</p>
{:else}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (script focus only, never in the tab order) -->
	<div bind:this={host} tabindex="-1" class="outline-none [&>svg]:max-h-[calc(100dvh-8rem)] [&>svg]:max-w-[92vw] [&>svg]:h-auto [&>svg]:w-auto [&>svg]:rounded">
		{#if image.status === "ready"}
			<!-- Constant attributes: after creation only pele writes viewBox. -->
			<svg role="img" aria-label="Preview" width={image.width} height={image.height} viewBox="0 0 {image.width} {image.height}">
				<image href={src} width={image.width} height={image.height} />
			</svg>
		{/if}
	</div>
{/if}
