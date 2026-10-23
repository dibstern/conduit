<!-- Shared attachment row for images and file chips. -->
<!-- Purely client-side display — no WS messages sent. -->
<!-- Preserves #image-preview wrapper and .paste-thumb / .paste-chip classes. -->

<script lang="ts">
	import ImageAttachmentThumb from "../ui/ImageAttachmentThumb.svelte";
	import FileAttachmentChip from "../ui/FileAttachmentChip.svelte";
	import { formatFileSize } from "../../utils/format.js";
	import type { DraftAttachmentItem } from "../../stores/composer-draft/state.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";

	let {
		images,
		onRemove,
		projectSlug,
	}: {
		images: readonly DraftAttachmentItem[];
		onRemove: (id: string) => void;
		projectSlug?: string | null;
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
				{@const src = image.hash ? `/p/${encodeURIComponent(projectSlug ?? getCurrentSlug() ?? "")}/attachments/${image.hash}` : image.dataUrl ?? ""}
				{#if image.mime.startsWith("image/")}
				<ImageAttachmentThumb {src} name={image.name} imageId={image.id} onremove={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onRemove(image.id);
				}} />
				{:else}
					<FileAttachmentChip testid="file-attachment-chip" name={image.name} detail={formatFileSize(image.size)} onremove={() => onRemove(image.id)} />
				{/if}
				{#if image.error}<span role="status" class="text-[11px] text-text-muted">{image.error}</span>{/if}
			{/each}
		</div>
	</div>
{/if}
