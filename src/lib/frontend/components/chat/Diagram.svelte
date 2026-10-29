<!-- Draws one mermaid source with pele. Pele owns the zoom host; CSS owns its size, pele only measures it. -->
<script lang="ts">
	import type { DiagramType, Mounted } from "pele/lazy";
	import { loadPele, nextRetry, retry } from "../../utils/diagram-loader.js";
	import Button from "../ui/Button.svelte";
	import CodeBlockHeader from "../ui/CodeBlockHeader.svelte";

	let { source, variant }: { source: string; variant: "inline" | "viewer" } = $props();

	async function download(text: string) {
		const pele = await loadPele();
		let type: DiagramType | null = null;
		try {
			type = pele.detectType(text);
		} catch {
			// Unknown type: mount anyway so pele explains it in its error box.
		}
		await pele.load(type);
		return pele;
	}

	// failed has no payload: pele draws its own error box, so we never hold a second copy.
	let status = $state<"loading" | "ready" | "failed" | "loadFailed">("loading");
	let host: HTMLDivElement | undefined = $state();
	let showSource = $state(false);
	const failed = $derived(status === "failed" || status === "loadFailed");

	// The only writer of status.
	$effect(() => {
		if (!host) return;
		const target = host;
		const text = source;
		let cancelled = false;
		let mounted: Mounted | undefined;
		const attempt = (): void => {
			status = "loading";
			download(text).then(
				(pele) => {
					if (cancelled) return;
					mounted = pele.mount(target, text, {
						zoom: "auto",
						onRender: () => {
							if (!cancelled) status = "ready";
						},
						onError: () => {
							if (!cancelled) status = "failed";
						},
					});
				},
				() => {
					if (cancelled) return;
					status = "loadFailed";
					void nextRetry().then(() => {
						if (!cancelled) attempt();
					});
				},
			);
		};
		attempt();
		return () => {
			cancelled = true;
			mounted?.destroy();
		};
	});
</script>

<div class="my-2 overflow-hidden rounded-lg border border-border-subtle bg-code-bg" data-diagram data-variant={variant}>
	<CodeBlockHeader label="mermaid" code={source}>
		{#snippet controls()}
			{#if !failed}
				<Button variant="ghost" size="content" tone="muted" iconOnly icon={showSource ? "workflow" : "code"} iconSize={14} touchTarget class="size-[28px] shrink-0" ariaLabel={showSource ? "Show diagram" : "Show code"} title={showSource ? "Show diagram" : "Show code"} onclick={() => (showSource = !showSource)} />
			{/if}
		{/snippet}
	</CodeBlockHeader>
	<div class="overflow-x-auto p-4">
		<!-- Hidden, never unmounted: toggling back shows the same drawing. The cap shrinks tall diagrams, so pele offers zoom.
		     pele's zoom controls (up to 90px) hang inside the host; room for them stops an inner scrollbar swallowing the wheel. -->
		<div bind:this={host} hidden={showSource && !failed} class={["has-[>.pele-zoom:not([hidden])]:min-h-[90px]", variant === "inline" && "[&>svg]:max-h-[380px] [&>svg]:w-auto"]}></div>
		{#if status === "loadFailed"}
			<p class="text-[13px] text-error">
				The diagram renderer failed to load ·
				<Button variant="ghost" size="content" tone="accent" onclick={retry}>Retry</Button>
			</p>
		{/if}
		{#if showSource || failed}
			<pre class="mt-2 mb-0"><code>{source}</code></pre>
		{/if}
	</div>
</div>
