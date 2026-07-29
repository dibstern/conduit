<script lang="ts">
	import ModelSelector from "../ModelSelector.svelte";

	let {
		reserveDropUpSpace = false,
	}: { reserveDropUpSpace?: boolean } = $props();
</script>

{#if reserveDropUpSpace}
	<div class="flex h-80 w-full items-end">
		<ModelSelector />
	</div>
{:else}
	<ModelSelector />
{/if}
