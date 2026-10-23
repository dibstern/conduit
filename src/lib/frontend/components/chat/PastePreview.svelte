<!-- Shared attachment row for images and file chips. -->
<!-- Purely client-side display — no WS messages sent. -->
<!-- Preserves #image-preview wrapper and .paste-thumb / .paste-chip classes. -->

<script lang="ts">
	import ImageAttachmentThumb from "../ui/ImageAttachmentThumb.svelte";
	import FileAttachmentChip from "../ui/FileAttachmentChip.svelte";
	import { formatFileSize } from "../../utils/format.js";
	import type { PendingAttachment } from "../../types.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";

	let {
		images,
		onRemove,
	}: {
		images: PendingAttachment[];
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
				{@const src = "ref" in image ? `/p/${encodeURIComponent(getCurrentSlug() ?? "")}/attachments/${image.ref.attachmentHash}` : image.dataUrl}
				{#if "ref" in image ? image.ref.mime.startsWith("image/") : image.dataUrl.startsWith("data:image/")}
				<ImageAttachmentThumb {src} name={image.name} imageId={image.id} onremove={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onRemove(image.id);
				}} />
				{:else}
					<FileAttachmentChip testid="file-attachment-chip" name={image.name} detail={"ref" in image ? image.ref.mime : formatFileSize(image.size)} onremove={() => onRemove(image.id)} />
				{/if}
			{/each}
		</div>
	</div>
{/if}
