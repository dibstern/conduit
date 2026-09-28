<!--
  These stories exercise the phone layout at a pinned width rather than
  inheriting the Storybook canvas. `width` also lets the narrowest supported
  phone get its own truncation assertion.
-->
<script lang="ts">
	import SessionBar from "../SessionBar.svelte";

	let { width = 393 }: { width?: number } = $props();
</script>

<div class="max-w-full" style="width: {width}px">
	<SessionBar />
</div>
