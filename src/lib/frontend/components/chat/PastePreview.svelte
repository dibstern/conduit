<!-- ─── Paste Preview ──────────────────────────────────────────────────────── -->
<!-- Horizontal row of image thumbnails for images pasted/dropped into input. -->
<!-- Purely client-side display — no WS messages sent. -->
<!-- Preserves #image-preview wrapper and .paste-thumb / .paste-chip classes. -->

<script lang="ts">
	import type { PendingImage } from "../../types.js";
	import { formatFileSize, escapeHtml } from "../../utils/format.js";

	let {
		images,
		onRemove,
	}: {
		images: PendingImage[];
		onRemove: (id: string) => void;
	} = $props();

	const hasImages = $derived(images.length > 0);

	/** Truncate a name for display under the thumbnail. */
	function truncateName(name: string, maxLen = 20): string {
		if (name.length <= maxLen) return name;
		return `${name.slice(0, maxLen)}\u2026`;
	}
</script>

{#if hasImages}
	<div id="image-preview">
		<div
			class="paste-preview-bar flex items-center gap-2 px-4 py-2 overflow-x-auto max-h-[90px] border-t border-border-subtle bg-bg-surface"
			style="-webkit-overflow-scrolling: touch"
		>
			{#each images as image (image.id)}
				<div
					class="paste-thumb group relative shrink-0 w-[60px] h-[60px] rounded-lg overflow-hidden border border-border bg-bg-alt"
					data-image-id={image.id}
				>
					<img
						src={image.dataUrl}
						alt={image.name}
						class="w-full h-full object-cover block"
					/>
					<button
						class="paste-remove-btn absolute top-0.5 right-0.5 w-[18px] h-[18px] border-none rounded-full bg-[rgba(0,0,0,0.6)] text-white text-sm leading-none flex items-center justify-center cursor-pointer opacity-0 transition-opacity duration-150 group-hover:opacity-100"
						title="Remove image"
						onclick={(e: MouseEvent) => {
							e.preventDefault();
							e.stopPropagation();
							onRemove(image.id);
						}}
					>
						&#x2715;
					</button>
					<span
						class="paste-thumb-name absolute bottom-0 left-0 right-0 text-xs leading-[1.2] text-white bg-[rgba(0,0,0,0.55)] px-[3px] py-px text-center overflow-hidden text-ellipsis whitespace-nowrap"
					>
						{truncateName(image.name)}
					</span>
				</div>
			{/each}
		</div>
	</div>
{/if}
