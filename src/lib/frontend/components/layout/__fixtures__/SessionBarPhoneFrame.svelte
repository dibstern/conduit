<!--
  Phone stories pin their width for truncation assertions. Desktop stories
  use `width="full"` to fill the Storybook canvas.
-->
<script lang="ts">
	import type { rpc } from "../../../transport/ws-rpc-client.js";
	import type { BannerConfig } from "../../../types.js";
	import Banners from "../../overlays/Banners.svelte";
	import SessionBar from "../SessionBar.svelte";

	let {
		width = 393,
		height,
		island = false,
		getGoalDetails,
		generateGoalSummary,
		banners,
	}: {
		width?: number | "full";
		height?: number;
		island?: boolean;
		getGoalDetails?: (input: Parameters<typeof rpc<"GetGoalDetails">>[1]) => ReturnType<typeof rpc<"GetGoalDetails">>;
		generateGoalSummary?: (input: Parameters<typeof rpc<"GenerateGoalSummary">>[1]) => ReturnType<typeof rpc<"GenerateGoalSummary">>;
		banners?: BannerConfig[];
	} = $props();
</script>

<div id={island ? "app" : undefined} class="max-w-full {island ? 'phone-session relative min-h-[180px] bg-bg' : ''}" style:width={width === "full" ? "100%" : `${width}px`} style:height={height ? `${height}px` : undefined} style:contain={height ? "layout" : undefined}>
	{#if island}
		<!-- Mirrors ChatLayout: the phone chrome stack overlays the chat area. -->
		<div id="session-chrome"><SessionBar {getGoalDetails} {generateGoalSummary} /><Banners /></div>
		<div id="chat-area" class="island-transcript relative pt-16 pl-4 text-sm text-text-muted">Transcript</div>
	{:else}
		{#if banners}<Banners {banners} presentation="session-header" />{/if}
		<SessionBar {getGoalDetails} {generateGoalSummary} />
	{/if}
</div>
