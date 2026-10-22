<script lang="ts">
	import Button from "./Button.svelte";
	let { src, name, imageId, onremove }: { src: string; name: string; imageId?: string; onremove: (event: MouseEvent) => void } = $props();
</script>

<div data-image-id={imageId} class="paste-thumb relative size-[48px] shrink-0 rounded-[10px] bg-bg-raised">
	<img {src} alt={name} class="block size-full rounded-[10px] object-cover" />
	<span class="absolute -right-[6px] -top-[6px]">
		<Button variant="inverse" size="content" iconOnly icon="x" iconSize={10} ariaLabel={`Remove image ${name}`} title="Remove image" class="paste-remove-btn size-[18px] rounded-full" touchTarget onclick={onremove} />
	</span>
</div>
