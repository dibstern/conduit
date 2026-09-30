<!--
  These stories exercise the phone layout at a pinned width rather than
  inheriting the Storybook canvas. `width` also lets the narrowest supported
  phone get its own truncation assertion.
-->
<script lang="ts">
	import SessionBar from "../SessionBar.svelte";

	let { width = 393, island = false }: { width?: number; island?: boolean } = $props();
</script>

<div id={island ? "app" : undefined} class="max-w-full {island ? 'phone-session relative min-h-[180px] bg-bg' : ''}" style="width: {width}px">
	{#if island}
		<!-- Mirrors ChatLayout: the phone chrome stack overlays the chat area. -->
		<div id="session-chrome"><SessionBar /></div>
		<div id="chat-area" class="island-transcript relative pt-16 pl-4 text-sm text-text-muted">Transcript</div>
	{:else}
		<SessionBar />
	{/if}
</div>
