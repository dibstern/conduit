<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import MenuCheckboxItem from "../ui/MenuCheckboxItem.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import HoldMenuTile from "../ui/HoldMenuTile.svelte";
	import LabelledGridGroup from "../ui/LabelledGridGroup.svelte";
	import Tile from "../ui/Tile.svelte";
	import type { SessionInfo } from "../../types.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import AutoSettleRow from "./AutoSettleRow.svelte";
	import { sessionCommandKeysHint, type SessionCommand, type SessionCommandEntry } from "./session-commands.js";

	let {
		commands,
		onselect,
		presentation = "menu",
		session,
		now = Date.now(),
		settleShortcutTag,
	}: {
		commands: readonly SessionCommandEntry[];
		onselect: (run: SessionCommand["run"]) => void;
		presentation?: "menu" | "sheet" | "popover";
		session?: SessionInfo;
		now?: number;
		settleShortcutTag?: string;
	} = $props();
	const triage = $derived(commands.filter((item) => item.section === "triage" && item.checked === undefined));
	const management = $derived(commands.filter((item) => item.section === "manage" || item.section === "danger"));
</script>

{#snippet tile(item: SessionCommandEntry)}
	{#if item.options && !item.disabledReason}
		<HoldMenuTile
			data-testid={item.testId}
			aria-label={item.label}
			label={item.shortLabel ?? item.label}
			icon={item.icon}
			subLine={item.detail ?? undefined}
			tag={presentation === "sheet" && !item.detail ? "hold" : undefined}
			activation={presentation === "popover" ? "click" : "hold"}
			title={item.options.title}
			hint={item.options.hint}
			items={item.options.items.map((option) => ({ ...option, action: () => onselect(option.run) }))}
		/>
	{:else}
		<Tile
			data-testid={item.testId}
			aria-label={item.label}
			label={item.shortLabel ?? item.label}
			icon={item.icon}
			subLine={item.detail ?? undefined}
			tag={item.testId === "session-ctx-settle" && !item.disabledReason ? settleShortcutTag : undefined}
			variant={item.danger ? "danger" : item.emphasis ?? "default"}
			disabledReason={item.disabledReason}
			ondisabledselect={() => { if (item.disabledReason) showToast(item.disabledReason, { variant: "pinned" }); }}
			onselect={() => onselect(item.run)}
		/>
	{/if}
{/snippet}

{#snippet commandDetails(item: SessionCommandEntry)}
	{#if item.checked !== undefined}<span class="w-[13px] shrink-0" aria-hidden="true"></span>{:else if !item.danger}<Icon name={item.icon} size={13} />{/if}
	<span>{item.label}</span>
	{#if item.keys}<span class="shortcut-hint ml-auto text-xs text-text-muted" aria-hidden="true">{sessionCommandKeysHint(item.keys)}</span>{/if}
	{#if item.disabledReason}<span class="ml-auto text-xs text-text-dimmer">{item.disabledReason}</span>{/if}
{/snippet}

{#if presentation !== "menu"}
	<LabelledGridGroup label="Triage" compact={presentation === "popover"}>
		{#each triage as item (item.testId)}{@render tile(item)}{/each}
	</LabelledGridGroup>
	{#if session}<AutoSettleRow {session} {now} />{/if}
	<LabelledGridGroup label="Session" columns={management.length > 4 ? 5 : 4}>
		{#each management as item (item.testId)}{@render tile(item)}{/each}
	</LabelledGridGroup>
{:else}
{#each commands as item, index (index)}
	{#if index > 0 && item.section !== commands[index - 1]?.section}
		<MenuSeparator />
	{/if}
	{#if item.checked !== undefined}
		<MenuCheckboxItem
			data-testid={item.testId}
			class="min-h-[44px] md:min-h-0"
			checked={item.checked}
			disabled={item.disabledReason != null}
			onselect={() => onselect(item.run)}
		>
			{@render commandDetails(item)}
		</MenuCheckboxItem>
	{:else if item.danger}
		<MenuItem
			data-testid={item.testId}
			class="min-h-[44px] md:min-h-0"
			variant="danger"
			disabled={item.disabledReason != null}
			onselect={() => onselect(item.run)}
		>
			{@render commandDetails(item)}
		</MenuItem>
	{:else}
		<MenuItem
			data-testid={item.testId}
			class="min-h-[44px] md:min-h-0"
			variant="default"
			disabled={item.disabledReason != null}
			onselect={() => onselect(item.run)}
		>
			{@render commandDetails(item)}
		</MenuItem>
	{/if}
{/each}
{/if}
