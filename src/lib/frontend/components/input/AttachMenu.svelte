<!-- ─── Attach Menu ─────────────────────────────────────────────────────────── -->
<!-- Attach button with camera/photos dropdown menu. -->

<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";
	import Surface from "../ui/Surface.svelte";

	let { open, onToggle, onCamera, onPhotos }: {
		open: boolean;
		onToggle: () => void;
		onCamera: () => void;
		onPhotos: () => void;
	} = $props();
</script>

<div id="attach-wrap" class="relative shrink-0 flex flex-col">
	<!-- The column parent keeps Button's inline-flex out of a line box, avoiding a descender gap. -->
	<Button
		variant="secondary"
		size="content"
		tone="muted"
		hoverFill="surface"
		iconOnly
		icon="plus"
		iconSize={18}
		id="attach-btn"
		type="button"
		ariaLabel="Attach"
		class="w-7 h-7 rounded-md bg-bg-alt"
		onclick={onToggle}
	/>
	<Surface
		variant="card"
		radius="panel"
		elevation="menu-lg"
		id="attach-menu"
		class="absolute bottom-[calc(100%+8px)] left-0 min-w-[170px] p-1 z-10 overflow-hidden {open
			? 'flex flex-col'
			: 'hidden'}"
	>
		<!-- The open menu is a column to avoid inline-flex line gaps. border-none suppressed
		     the old not-last border; dropping both keeps that divider invisible. -->
		<Button
			variant="ghost"
			size="content"
			align="start"
			hoverFill="overlay"
			class="attach-menu-item gap-2.5 w-full py-3 px-4 bg-none text-sm font-brand"
			id="attach-camera"
			type="button"
			onclick={onCamera}
		>
			<Icon name="camera" size={18} class="shrink-0" />
			<span>Take Photo</span>
		</Button>
		<!-- Same column layout and suppressed divider as the camera row above. -->
		<Button
			variant="ghost"
			size="content"
			align="start"
			hoverFill="overlay"
			class="attach-menu-item gap-2.5 w-full py-3 px-4 bg-none text-sm font-brand"
			id="attach-photos"
			type="button"
			onclick={onPhotos}
		>
			<Icon name="image" size={18} class="shrink-0" />
			<span>Add Photos</span>
		</Button>
	</Surface>
</div>
