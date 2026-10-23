<script lang="ts">
	import type { SessionAttention } from "../../types.js";
	import ConduitMark from "./ConduitMark.svelte";
	import Icon from "./Icon.svelte";

	let { attention = "idle", settled = false, snoozed = false, pinned = false, animate = true }: {
		attention?: SessionAttention;
		settled?: boolean;
		snoozed?: boolean;
		pinned?: boolean;
		animate?: boolean;
	} = $props();

	const needsYou = $derived(attention === "needs-approval" || attention === "needs-reply");
</script>

<span class="session-status-glyph grid size-[16px] shrink-0 place-items-center" data-state={pinned ? "pinned" : settled ? "settled" : snoozed ? "snoozed" : attention} aria-hidden="true">
	{#if pinned}
		<Icon name="pin" size={11} class="text-status-pinned" />
	{:else if settled}
		<span class="grid size-[14px] place-items-center rounded-full bg-success/18 text-success"><Icon name="check" size={9} /></span>
	{:else if snoozed}
		<Icon name="moon" size={13} class="text-status-snoozed" />
	{:else if needsYou}
		<span class="grid size-[14px] place-items-center rounded-full border-[1.5px] border-status-ask"><span class="size-[6px] rounded-full bg-status-ask"></span></span>
	{:else if attention === "working" || attention === "monitoring"}
		<ConduitMark size={16} variant="running" animated={animate} />
	{:else if attention === "done-unread"}
		<ConduitMark size={16} variant="unread" data-testid="session-unread-dot" />
	{:else if attention === "error"}
		<Icon name="octagon-alert" size={14} class="text-error" />
	{:else}
		<ConduitMark size={16} variant="idle" />
	{/if}
</span>
