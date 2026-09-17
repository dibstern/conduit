<!--
  SessionBar renders only at phone width (ChatLayout mounts it behind the
  compact media query), so the stories pin the width rather than inheriting the
  Storybook canvas. Without this the desktop project captures a 1440px-wide bar
  that no user can reach, and the truncation assertions have nothing to
  truncate. `width` exists so the narrowest supported phone gets its own story.
-->
<script lang="ts">
	import SessionBar from "../SessionBar.svelte";

	let { width = 393 }: { width?: number } = $props();
</script>

<div class="max-w-full" style="width: {width}px">
	<SessionBar />
</div>
