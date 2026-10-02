<script lang="ts">
	import TextButton from "../ui/TextButton.svelte";

	let { selectMode, selectionCount, allSelected, onselectall, ondone }: {
		selectMode: boolean;
		selectionCount: number;
		allSelected: boolean;
		onselectall: () => void;
		ondone: () => void;
	} = $props();
</script>

	<!-- Select-mode header stays outside the scroller. The list's title lives in
	     the sidebar's own header, so outside select mode there is nothing here. -->
	{#if selectMode}
		<div class="session-list-header flex shrink-0 items-center gap-2 px-4 py-1 font-brand">
			<span class="min-w-0 flex-1 text-sm font-semibold">{selectionCount} selected</span>
			<TextButton type="button" title={allSelected ? "Select none" : "Select all"} tone="dimmer" class="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-sm font-semibold" onclick={onselectall}>
				{allSelected ? "None" : "All"}
			</TextButton>
			<TextButton type="button" title="Done selecting" tone="dimmer" class="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-sm font-semibold" onclick={ondone}>Done</TextButton>
		</div>
	{/if}
