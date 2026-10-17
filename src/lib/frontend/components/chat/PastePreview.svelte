<!-- Horizontal row of image thumbnails for images pasted/dropped into input. -->
<!-- Purely client-side display — no WS messages sent. -->
<!-- Preserves #image-preview wrapper and .paste-thumb / .paste-chip classes. -->

<script lang="ts">
	import ImageAttachmentThumb from "../ui/ImageAttachmentThumb.svelte";
	import type { PendingImage } from "../../types.js";

	let {
		images,
		onRemove,
	}: {
		images: PendingImage[];
		onRemove: (id: string) => void;
	} = $props();

	const hasImages = $derived(images.length > 0);

</script>

{#if hasImages}
	<div id="image-preview">
		<div
			class="paste-preview-bar flex items-center gap-[10px] pt-[6px] pb-[12px] pr-[6px] overflow-x-auto"
			style="-webkit-overflow-scrolling: touch"
		>
			{#each images as image (image.id)}
				<ImageAttachmentThumb src={image.dataUrl} name={image.name} imageId={image.id} onremove={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onRemove(image.id);
				}} />
			{/each}
		</div>
	</div>
{/if}
