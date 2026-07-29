<!-- Reproduces the app-shell contract FileViewer depends on: on desktop it is a -->
<!-- height-bounded flex sibling of #app, so its code pane scrolls internally.    -->
<!-- Rendered without a bounded parent the pane grows to the full file height —   -->
<!-- the 1,282-line truncation fixture produced a 25,946px-tall baseline that     -->
<!-- exercised neither the internal scroll container nor the sticky line gutter.  -->
<script lang="ts">
	import FileViewer from "../FileViewer.svelte";

	let {
		visible = false,
		onClose,
	}: { visible?: boolean; onClose?: () => void } = $props();
</script>

<div class="flex h-screen w-full justify-end">
	<FileViewer {visible} {onClose} />
</div>
