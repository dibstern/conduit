<!-- Shared attachment row for images and file chips. -->
<!-- Purely client-side display — no WS messages sent. -->
<!-- Preserves #image-preview wrapper and .paste-thumb / .paste-chip classes. -->

<script lang="ts">
	import ImageAttachmentThumb from "../ui/ImageAttachmentThumb.svelte";
	import FileAttachmentChip from "../ui/FileAttachmentChip.svelte";
	import Button from "../ui/Button.svelte";
	import { formatFileSize } from "../../utils/format.js";
	import type { DraftAttachmentItem } from "../../stores/composer-draft/state.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { openLightbox } from "../../stores/ui.svelte.js";

	let {
		images,
		onRemove,
		onRetry,
		projectSlug,
	}: {
		images: readonly DraftAttachmentItem[];
		onRemove: (id: string) => void;
		onRetry?: (id: string) => void;
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
				<div data-testid="draft-attachment" data-attachment-id={image.id} data-status={image.status} class="flex shrink-0 items-center gap-[14px]">
				{#if image.mime.startsWith("image/")}
				<ImageAttachmentThumb {src} name={image.name} imageId={image.id} onopen={() => openLightbox(src)} onremove={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onRemove(image.id);
				}} />
				{:else}
					<FileAttachmentChip testid="file-attachment-chip" name={image.name} detail={formatFileSize(image.size)} onremove={() => onRemove(image.id)} />
				{/if}
				{#if image.status === "failed" || image.error}
					<div class="flex max-w-[220px] flex-col gap-1 text-[11px] text-text-muted">
						{#if image.status === "failed"}
							<span role="status" data-testid="draft-attachment-not-saved">not saved</span>
						{/if}
						{#if image.error}<span role="status" data-testid="draft-attachment-error">{image.error}</span>{/if}
						{#if image.status === "failed"}
							<div class="flex gap-2">
								<Button variant="ghost" size="sm" data-testid="draft-attachment-retry" ariaLabel="Retry" onclick={() => onRetry?.(image.id)}>Retry</Button>
								<Button variant="ghost" size="sm" data-testid="draft-attachment-remove" ariaLabel="Remove" onclick={() => onRemove(image.id)}>Remove</Button>
							</div>
						{/if}
					</div>
				{/if}
				</div>
			{/each}
		</div>
	</div>
{/if}
