<script lang="ts">
	import Button from "../ui/Button.svelte";
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
	     the sidebar's own header, so outside select mode there is nothing here.
	     It is tinted and carries an exit X so the mode is unmistakable: a plain
	     "N selected" title read like the list's normal state and was forgotten. -->
	{#if selectMode}
		<div class="session-list-header flex shrink-0 items-center gap-1 border-b border-accent bg-accent/20 py-1.5 pl-1.5 pr-2.5 font-brand">
			<Button variant="ghost" size="content" iconOnly icon="x" iconSize={18} tone="default" ariaLabel="Exit selection" title="Exit selection" class="size-[44px] md:size-8 justify-center rounded-lg" onclick={ondone} />
			<span class="flex min-w-0 flex-1 flex-col leading-tight">
				<span class="text-[11px] font-medium uppercase tracking-wider text-accent" aria-hidden="true">Selecting</span>
				<span class="text-sm font-semibold text-text">{selectionCount} selected</span>
			</span>
			<TextButton type="button" title={allSelected ? "Select none" : "Select all"} class="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 px-1.5 text-sm font-semibold" onclick={onselectall}>
				{allSelected ? "None" : "All"}
			</TextButton>
			<Button variant="primary" size="content" touchTarget title="Done selecting" class="rounded-full px-3.5 py-1 text-sm font-bold" onclick={ondone}>Done</Button>
		</div>
	{/if}
