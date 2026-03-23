<!-- ─── Attach Menu ─────────────────────────────────────────────────────────── -->
<!-- Attach button with camera/photos dropdown menu. -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";

	let { open, onToggle, onCamera, onPhotos }: {
		open: boolean;
		onToggle: () => void;
		onCamera: () => void;
		onPhotos: () => void;
	} = $props();
</script>

<div id="attach-wrap" class="relative shrink-0">
	<button
		id="attach-btn"
		type="button"
		aria-label="Attach"
		class="w-7 h-7 rounded-md border border-border bg-bg-alt text-text-muted cursor-pointer flex items-center justify-center transition-[background,color] duration-150 hover:bg-bg-surface hover:text-text"
		onclick={onToggle}
	>
		<Icon name="plus" size={18} />
	</button>
	<div
		id="attach-menu"
		class="absolute bottom-[calc(100%+8px)] left-0 min-w-[170px] bg-bg-surface border border-border rounded-[10px] p-1 shadow-[0_-4px_24px_rgba(var(--shadow-rgb),0.4)] z-10 overflow-hidden"
		class:hidden={!open}
	>
		<button
		class="attach-menu-item flex items-center gap-2.5 w-full py-3 px-4 border-none bg-none text-text-secondary text-sm cursor-pointer transition-[background,color] duration-150 not-last:border-b not-last:border-border-subtle hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text font-brand"
		id="attach-camera"
			type="button"
			onclick={onCamera}
		>
			<Icon name="camera" size={18} class="shrink-0" />
			<span>Take Photo</span>
		</button>
		<button
		class="attach-menu-item flex items-center gap-2.5 w-full py-3 px-4 border-none bg-none text-text-secondary text-sm cursor-pointer transition-[background,color] duration-150 not-last:border-b not-last:border-border-subtle hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text font-brand"
		id="attach-photos"
			type="button"
			onclick={onPhotos}
		>
			<Icon name="image" size={18} class="shrink-0" />
			<span>Add Photos</span>
		</button>
	</div>
</div>
