<!-- Draws one mermaid source with pele. Pele owns the zoom host; our styling sits on the root. -->
<script lang="ts">
	import type { DiagramType, Mounted } from "pele/lazy";
	import { loadPele } from "../../utils/diagram-loader.js";

	let { source, variant }: { source: string; variant: "inline" | "viewer" } = $props();

	// failed has no payload: pele draws its own error box, so we never hold a second copy.
	let status = $state<"loading" | "ready" | "failed" | "loadFailed">("loading");
	let host: HTMLDivElement | undefined = $state();

	// The only writer of status.
	$effect(() => {
		if (!host) return;
		const target = host;
		const text = source;
		let cancelled = false;
		let mounted: Mounted | undefined;
		status = "loading";
		const download = async () => {
			const pele = await loadPele();
			let type: DiagramType | null = null;
			try {
				type = pele.detectType(text);
			} catch {
				// Unknown type: mount anyway so pele explains it in its error box.
			}
			await pele.load(type);
			return pele;
		};
		download().then(
			(pele) => {
				if (cancelled) return;
				mounted = pele.mount(target, text, {
					zoom: false,
					onRender: () => {
						if (!cancelled) status = "ready";
					},
					onError: () => {
						if (!cancelled) status = "failed";
					},
				});
			},
			() => {
				if (!cancelled) status = "loadFailed";
			},
		);
		return () => {
			cancelled = true;
			mounted?.destroy();
		};
	});
</script>

<div class="my-2 overflow-x-auto rounded-lg border border-border-subtle bg-code-bg p-4" data-diagram data-variant={variant}>
	<div bind:this={host}></div>
	{#if status === "loadFailed"}
		<p class="text-[13px] text-error">The diagram renderer failed to load</p>
	{/if}
	{#if status === "failed" || status === "loadFailed"}
		<pre class="mt-2 mb-0"><code>{source}</code></pre>
	{/if}
</div>
