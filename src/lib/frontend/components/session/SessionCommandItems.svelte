<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import MenuCheckboxItem from "../ui/MenuCheckboxItem.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import { sessionCommandKeysHint, type SessionCommand, type SessionCommandEntry } from "./session-commands.js";

	let {
		commands,
		presentation,
		onselect,
	}: {
		commands: readonly SessionCommandEntry[];
		presentation: "menu" | "sheet";
		onselect: (run: SessionCommand["run"]) => void;
	} = $props();
</script>

{#snippet commandDetails(item: SessionCommand)}
	{#if presentation !== "sheet"}
		{#if item.icon}<Icon name={item.icon} size={13} />{:else if item.checked !== undefined}<span class="w-[13px] shrink-0" aria-hidden="true"></span>{/if}
	{/if}
	<span>{item.label}</span>
	{#if item.keys}<span class="shortcut-hint ml-auto text-xs text-text-muted" aria-hidden="true">{sessionCommandKeysHint(item.keys)}</span>{/if}
	{#if item.disabledReason}<span class="ml-auto text-xs text-text-dimmer">{item.disabledReason}</span>{/if}
{/snippet}

{#each commands as item, index (index)}
	{#if "divider" in item}
		<MenuSeparator />
	{:else if item.checked !== undefined}
		<MenuCheckboxItem
			data-testid={item.testId}
			class={presentation === "menu" ? "min-h-[44px] md:min-h-0" : undefined}
			icon={presentation === "sheet" ? item.icon : undefined}
			checked={item.checked}
			disabled={item.disabledReason != null}
			onselect={() => onselect(item.run)}
		>
			{@render commandDetails(item)}
		</MenuCheckboxItem>
	{:else if item.danger}
		<MenuItem
			data-testid={item.testId}
			class={presentation === "menu" ? "min-h-[44px] md:min-h-0" : undefined}
			icon={presentation === "sheet" ? item.icon : undefined}
			variant="danger"
			disabled={item.disabledReason != null}
			onselect={() => onselect(item.run)}
		>
			{@render commandDetails(item)}
		</MenuItem>
	{:else}
		<MenuItem
			data-testid={item.testId}
			class={presentation === "menu" ? "min-h-[44px] md:min-h-0" : undefined}
			icon={presentation === "sheet" ? item.icon : undefined}
			variant="default"
			disabled={item.disabledReason != null}
			onselect={() => onselect(item.run)}
		>
			{@render commandDetails(item)}
		</MenuItem>
	{/if}
{/each}
