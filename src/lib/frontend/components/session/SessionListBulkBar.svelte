<script lang="ts">
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";

	let { settleCount, snoozeCount, pinCount, selectionCount, unpinSelected, bulkPending, onsettle, onsnooze, onpin, ondelete }: {
		settleCount: number;
		snoozeCount: number;
		pinCount: number;
		selectionCount: number;
		unpinSelected: boolean;
		bulkPending: boolean;
		onsettle: () => void;
		onsnooze: () => void;
		onpin: () => void;
		ondelete: () => void;
	} = $props();
	const selectVerbClass = "min-w-0 flex-1 min-h-[50px] flex-col gap-1 rounded-lg text-[11px] disabled:opacity-[0.35] disabled:cursor-default";
</script>

		<div data-testid="select-bar" class="flex shrink-0 border-t border-border bg-bg-surface px-[6px] pt-2 pb-[calc(10px+env(safe-area-inset-bottom))] font-brand">
			<Button
				variant="ghost" size="content" tone="inherit" hoverFill="none" disabledStyle="none"
				disabled={settleCount === 0 || bulkPending}
				data-testid="select-bar-settle"
				ariaLabel={`Settle ${settleCount} ${settleCount === 1 ? "session" : "sessions"}`}
				class={selectVerbClass}
				onclick={() => { void onsettle(); }}
			><Icon name="check" size={17} /> Settle</Button>
			<Button
				variant="ghost" size="content" tone="inherit" hoverFill="none" disabledStyle="none"
				disabled={snoozeCount === 0 || bulkPending}
				data-testid="select-bar-snooze"
				ariaLabel={`Snooze ${snoozeCount} ${snoozeCount === 1 ? "session" : "sessions"}`}
				class={selectVerbClass}
				onclick={onsnooze}
			><Icon name="moon" size={17} /> Snooze</Button>
			<Button
				variant="ghost" size="content" tone="inherit" hoverFill="none" disabledStyle="none"
				disabled={pinCount === 0 || bulkPending}
				data-testid="select-bar-pin"
				ariaLabel={`${unpinSelected ? "Unpin" : "Pin"} ${pinCount} ${pinCount === 1 ? "session" : "sessions"}`}
				class={selectVerbClass}
				onclick={() => { void onpin(); }}
			><Icon name={unpinSelected ? "star-off" : "star"} size={17} /> {unpinSelected ? "Unpin" : "Pin"}</Button>
			<Button
				variant="ghost" size="content" tone="inherit" hoverFill="none" disabledStyle="none"
				disabled={selectionCount === 0 || bulkPending}
				data-testid="select-bar-delete"
				ariaLabel={`Delete ${selectionCount} ${selectionCount === 1 ? "session" : "sessions"}`}
				class="{selectVerbClass} text-error"
				onclick={ondelete}
			><Icon name="trash-2" size={17} /> Delete</Button>
		</div>
