<script lang="ts">
	import ContextWindowSelector from "../ContextWindowSelector.svelte";

	let {
		reserveDropUpSpace = false,
	}: { reserveDropUpSpace?: boolean } = $props();
</script>

{#if reserveDropUpSpace}
	<div class="flex h-40 w-full items-end justify-end">
		<ContextWindowSelector />
	</div>
{:else}
	<ContextWindowSelector />
{/if}
