<script lang="ts">
	import type { SessionAttention } from "../../types.js";
	import ConduitMark from "./ConduitMark.svelte";
	import Icon from "./Icon.svelte";

	let { attention = "idle", settled = false, snoozed = false, pinned = false, animate = true, size = 16 }: {
		attention?: SessionAttention;
		settled?: boolean;
		snoozed?: boolean;
		pinned?: boolean;
		animate?: boolean;
		size?: number;
	} = $props();

	const needsYou = $derived(attention === "needs-approval" || attention === "needs-reply");
</script>

<span class="session-status-glyph grid shrink-0 place-items-center" style:width={`${size}px`} style:height={`${size}px`} data-state={pinned ? "pinned" : settled ? "settled" : snoozed ? "snoozed" : attention} aria-hidden="true">
	{#if pinned}
		<Icon name="pin" size={size * 11 / 16} class="text-status-pinned" />
	{:else if settled}
		<span class="grid place-items-center rounded-full bg-success/18 text-success" style:width={`${size * 14 / 16}px`} style:height={`${size * 14 / 16}px`}><Icon name="check" size={size * 9 / 16} /></span>
	{:else if snoozed}
		<Icon name="moon" size={size * 13 / 16} class="text-status-snoozed" />
	{:else if needsYou}
		<span class="grid place-items-center rounded-full border-status-ask" style:width={`${size * 14 / 16}px`} style:height={`${size * 14 / 16}px`} style:border-width={`${size * 1.5 / 16}px`}><span class="rounded-full bg-status-ask" style:width={`${size * 6 / 16}px`} style:height={`${size * 6 / 16}px`}></span></span>
	{:else if attention === "working" || attention === "monitoring"}
		<ConduitMark {size} variant="running" tone={attention === "monitoring" ? "goal" : "accent"} animated={animate} />
	{:else if attention === "done-unread"}
		<ConduitMark {size} variant="unread" data-testid="session-unread-dot" />
	{:else if attention === "error"}
		<Icon name="octagon-alert" size={size * 14 / 16} class="text-error" />
	{:else}
		<ConduitMark {size} variant="idle" />
	{/if}
</span>
