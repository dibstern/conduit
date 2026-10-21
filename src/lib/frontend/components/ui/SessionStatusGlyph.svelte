<script lang="ts">
	import type { SessionAttention } from "../../types.js";
	import Icon from "./Icon.svelte";

	let { attention = "idle", settled = false, snoozed = false }: {
		attention?: SessionAttention;
		settled?: boolean;
		snoozed?: boolean;
	} = $props();

	const needsYou = $derived(attention === "needs-approval" || attention === "needs-reply");
</script>

<span class="session-status-glyph grid size-[14px] shrink-0 place-items-center rounded-full" data-state={settled ? "settled" : snoozed ? "snoozed" : attention} aria-hidden="true">
	{#if settled}
		<span class="grid size-[14px] place-items-center rounded-full bg-success/18 text-success"><Icon name="check" size={9} /></span>
	{:else if snoozed}
		<Icon name="moon" size={13} class="text-status-snoozed" />
	{:else if needsYou}
		<span class="grid size-[14px] place-items-center rounded-full border-[1.5px] border-status-ask"><span class="size-[6px] rounded-full bg-status-ask"></span></span>
	{:else if attention === "working" || attention === "monitoring"}
		<span class="size-[14px] animate-spin rounded-full border-[1.5px] border-border-chip motion-reduce:animate-none {attention === 'monitoring' ? 'border-t-status-goal' : 'border-t-accent'}"></span>
	{:else if attention === "done-unread"}
		<span data-testid="session-unread-dot" class="size-[8px] rounded-full bg-session-done"></span>
	{:else if attention === "error"}
		<Icon name="octagon-alert" size={14} class="text-error" />
	{:else}
		<span class="size-[14px] rounded-full border-[1.5px] border-dashed border-text-dimmer"></span>
	{/if}
</span>
