<script lang="ts">
	import Button from "../ui/Button.svelte";
	import TextButton from "../ui/TextButton.svelte";

	let { selectMode, selectionCount, allSelected, onselectall, ondone, onenterselect }: {
		selectMode: boolean;
		selectionCount: number;
		allSelected: boolean;
		onselectall: () => void;
		ondone: () => void;
		onenterselect: () => void;
	} = $props();

	const TOOLBAR_ICON_BOX = "h-6 w-6 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-md";
</script>

	<!-- Select-mode header stays outside the scroller. -->
	{#if selectMode}
		<div class="session-list-header flex shrink-0 items-center gap-2 px-4 py-1 bg-bg-surface font-brand">
			<span class="min-w-0 flex-1 text-sm font-semibold">{selectionCount} selected</span>
			<TextButton type="button" title={allSelected ? "Select none" : "Select all"} tone="dimmer" class="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-sm font-semibold" onclick={onselectall}>
				{allSelected ? "None" : "All"}
			</TextButton>
			<TextButton type="button" title="Done selecting" tone="dimmer" class="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-sm font-semibold" onclick={ondone}>Done</TextButton>
		</div>
	{:else}
		<div class="shrink-0 px-2">
			<div class="session-list-header flex items-center justify-between px-2 py-1">
				<span class="text-sm font-semibold uppercase tracking-[0.5px] text-text-dimmer font-brand">Sessions</span>
				<div class="session-list-header-actions flex items-center gap-0.5">
					<Button
						variant="toolbar"
						size="content"
						class={TOOLBAR_ICON_BOX}
						iconOnly
						iconSize={14}
						icon="circle-check"
						title="Select sessions"
						ariaLabel="Select sessions"
						onclick={() => onenterselect()}
					/>
				</div>
			</div>
		</div>
	{/if}
