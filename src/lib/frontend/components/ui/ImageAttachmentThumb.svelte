<script lang="ts">
	import Button from "./Button.svelte";
	let { src, name, imageId, onopen, onremove }: { src: string; name: string; imageId?: string; onopen: () => void; onremove: (event: MouseEvent) => void } = $props();
	let failedSrc = $state<string | null>(null);
</script>

<div data-image-id={imageId} class="paste-thumb relative size-[64px] md:size-[48px] shrink-0 rounded-[10px] bg-bg-raised">
	{#if failedSrc === src}
		<span role="img" aria-label={name} class="flex size-full items-center justify-center p-1 text-center text-xs text-text-muted">image unavailable</span>
	{:else}
		<Button variant="ghost" hoverFill="none" size="content" ariaLabel={`View image ${name}`} class="block size-full rounded-[10px] cursor-zoom-in" onclick={onopen}>
			<img {src} alt={name} class="block size-full rounded-[10px] object-cover" onerror={() => failedSrc = src} />
		</Button>
	{/if}
	<span class="absolute -right-[6px] -top-[6px]">
		<Button variant="inverse" size="content" iconOnly icon="x" iconSize={10} ariaLabel={`Remove image ${name}`} title="Remove image" class="paste-remove-btn size-[18px] rounded-full" touchTarget onclick={onremove} />
	</span>
</div>
