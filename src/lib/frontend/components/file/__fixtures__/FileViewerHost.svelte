<!-- Reproduces the height-bounded desktop Files pane so code scrolls internally. -->
<!-- Rendered without a bounded parent the pane grows to the full file height —   -->
<!-- the 1,282-line truncation fixture produced a 25,946px-tall baseline that     -->
<!-- exercised neither the internal scroll container nor the sticky line gutter.  -->
<script lang="ts">
	import FileViewer from "../FileViewer.svelte";

	let {
		visible = false,
		onClose = () => undefined,
	}: {
		visible?: boolean | undefined;
		onClose?: (() => void) | undefined;
	} = $props();
</script>

<div class="flex h-screen w-full justify-end">
	<div class="flex w-[clamp(280px,40%,640px)] border-l border-border">
		<FileViewer {visible} {onClose} />
	</div>
</div>
