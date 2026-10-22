<!--
  Phone stories pin their width for truncation assertions. Desktop stories
  use `width="full"` to fill the Storybook canvas.
-->
<script lang="ts">
	import type { rpc } from "../../../transport/ws-rpc-client.js";
	import type { BannerConfig } from "../../../types.js";
	import Banners from "../../overlays/Banners.svelte";
	import SessionBar from "../SessionBar.svelte";
	import DebugPanel from "../../debug/DebugPanel.svelte";
	import { featureFlags } from "../../../stores/feature-flags.svelte.js";
	import { wsDebugState } from "../../../stores/ws-debug.svelte.js";

	let {
		width = 393,
		height,
		island = false,
		getGoalDetails,
		banners,
	}: {
		width?: number | "full";
		height?: number;
		island?: boolean;
		getGoalDetails?: (input: Parameters<typeof rpc<"GetGoalDetails">>[1]) => ReturnType<typeof rpc<"GetGoalDetails">>;
		banners?: BannerConfig[];
	} = $props();
</script>

<div id={island ? "app" : undefined} class="max-w-full {island ? 'phone-session relative min-h-[180px] bg-bg' : ''}" style:width={width === "full" ? "100%" : `${width}px`} style:height={height ? `${height}px` : undefined} style:contain={height ? "layout" : undefined}>
	{#if island}
		<!-- Mirrors ChatLayout: the phone chrome stack overlays the chat area. -->
		<div id="session-chrome"><SessionBar {getGoalDetails} /><Banners /></div>
		<div id="chat-area" class="island-transcript relative pt-16 pl-4 text-sm text-text-muted">Transcript</div>
	{:else}
		{#if banners}<Banners {banners} presentation="session-header" />{/if}
		<SessionBar {getGoalDetails} />
	{/if}
</div>

{#if featureFlags.debug}
	<DebugPanel visible={wsDebugState.panelOpen} onClose={() => { wsDebugState.panelOpen = false; }} />
{/if}
