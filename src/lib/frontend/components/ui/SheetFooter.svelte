<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import Icon from "./Icon.svelte";

	let { actions }: {
		actions: readonly { label: string; ariaLabel?: string; testId?: string; icon?: string; tag?: string; onselect: (event: Event) => void; disabled?: boolean }[];
	} = $props();
</script>

<div class="flex items-center justify-around gap-[4px] px-[8px] pt-[6px]">
	{#each actions as action (action.label)}
		<DropdownMenu.Item disabled={action.disabled ?? false} onSelect={action.onselect} textValue={action.label} aria-label={action.ariaLabel} data-testid={action.testId} class="flex min-h-[44px] min-w-[44px] items-center justify-center gap-[6px] rounded-[8px] px-[6px] text-[13.5px] text-text-secondary cursor-pointer select-none touch-manipulation outline-hidden data-[highlighted]:bg-hover data-[disabled]:opacity-35">
			{#if action.icon}<span aria-hidden="true"><Icon name={action.icon} size={14} /></span>{/if}
			{action.label}
			{#if action.tag}<span class="rounded-[4px] bg-chip px-[5px] py-[1px] font-mono text-[10px] text-text-dimmer">{action.tag}</span>{/if}
		</DropdownMenu.Item>
	{/each}
</div>
