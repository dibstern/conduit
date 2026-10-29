<script lang="ts">
	import type { ComponentProps } from "svelte";
	import Tooltip from "../Tooltip.svelte";

	let {
		open = $bindable(false),
		delayDuration = 700,
		longText = false,
		interaction = "hoverable",
	}: {
		open?: boolean;
		delayDuration?: number;
		longText?: boolean;
		interaction?: ComponentProps<typeof Tooltip>["interaction"];
	} = $props();
</script>

<Tooltip bind:open {delayDuration} {interaction}>
	{#snippet trigger({ props })}
		<button
			{...props}
			class="rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:bg-bg-alt"
		>
			Show details
		</button>
	{/snippet}

	{#if longText}
		This longer tooltip demonstrates how explanatory content wraps within its
		maximum width while remaining readable beside compact controls across desktop
		layouts without crowding the surrounding Conduit interface.
	{:else}
		Verbose logging · Ctrl+L
	{/if}
</Tooltip>
