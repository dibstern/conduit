<!--
  SettingsGroup — a settings card. It owns the card fill and the
  hairline between each direct child, so rows (SettingsRow, ClaudeSettingRow)
  never draw their own.

  Plain: an optional title above the card, with `actions` at its right and an
  optional one-line `caption` under it.

  Collapsible: the title moves into the card as a SettingsRow navigation
  header with a one-line `summary`, and `open` is controlled and bindable so a
  parent can open a group from a link or a search. `actions` sit beside the
  disclosure button, never inside it, so "Show all" does not also expand the
  group, and the header stays free of nested interactive elements.

  `id` lands on the section (a link or scroll target) and names it by its
  title, which gets the id `<id>-title`.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import SettingsRow from "./SettingsRow.svelte";

	let {
		id,
		title,
		caption,
		collapsible = false,
		open = $bindable(false),
		summary,
		actions,
		testId,
		children,
	}: {
		id?: string;
		title?: string;
		/** Plain groups only: a collapsible group's title lives inside the card. */
		caption?: string;
		collapsible?: boolean;
		open?: boolean;
		summary?: string;
		actions?: Snippet;
		testId?: string;
		children: Snippet;
	} = $props();

	const card = "rounded-[12px] bg-settings-card overflow-hidden";
	const rows = "divide-y divide-settings-separator";
	const titleId = $derived(id && title ? `${id}-title` : undefined);
</script>

<section
	{id}
	class="mt-[16px] first:mt-0 flex flex-col gap-[6px]"
	aria-labelledby={titleId}
	data-testid={testId}
>
	{#if collapsible}
		<div class={card}>
			<div class="flex items-center">
				<SettingsRow
					label={title ?? ""}
					labelId={titleId}
					{summary}
					expanded={open}
					onclick={() => (open = !open)}
					class="flex-1 min-w-0"
				/>
				{#if actions}
					<div class="flex shrink-0 items-center gap-1.5 pr-[12px]">{@render actions()}</div>
				{/if}
			</div>
			{#if open}
				<div class="border-t border-settings-separator {rows}">{@render children()}</div>
			{/if}
		</div>
	{:else}
		{#if title || actions}
			<div class="flex items-center gap-2 px-[4px]">
				{#if title}<h3 id={titleId} class="text-[12px] max-md:text-[13px] font-medium text-text-dimmer">{title}</h3>{/if}
				{#if actions}<div class="ml-auto flex items-center gap-1.5">{@render actions()}</div>{/if}
			</div>
		{/if}
		{#if caption}<p class="-mt-[2px] px-[4px] text-[11px] text-text-dimmer max-md:text-[12px]">{caption}</p>{/if}
		<div class="{card} {rows}">{@render children()}</div>
	{/if}
</section>
