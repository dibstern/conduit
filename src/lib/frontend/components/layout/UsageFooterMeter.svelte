<script lang="ts">
	import type { UsageReading, UsageWindow } from "../../../contracts/limit-recovery.js";
	import { getInstanceById } from "../../stores/instance.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { orderedUsageAccounts, usageState } from "../../stores/usage.svelte.js";
	import { usageDisplay } from "../../utils/continuation.js";
	import AccountDot from "../ui/AccountDot.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import Icon from "../ui/Icon.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";
	import Surface from "../ui/Surface.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import { openSettings } from "./chrome-actions.js";

	let { phone = false, height = $bindable(0) }: { phone?: boolean; height?: number } = $props();

	const id = $props.id();
	const harnesses = ["claude", "codex", "cursor"] as const;
	const windowLabels = { five_hour: "5h", seven_day: "Week", month: "Month" } as const;
	type WindowKind = keyof typeof windowLabels;
	const kinds: readonly WindowKind[] = ["five_hour", "seven_day", "month"];
	const defaultAccount = $derived(projectState.projects.find((project) => project.slug === getCurrentSlug())?.instanceId);
	const accounts = $derived(orderedUsageAccounts());
	// The phone docks the default account's row and any account that needs attention; the sheet has the rest.
	const docked = $derived.by(() => {
		const shown = accounts.filter((reading) => {
			if (reading.accountId === defaultAccount) return true;
			const { level } = usageDisplay(reading, usageState.limits.warnAt);
			return level === "warn" || level === "limited";
		});
		return shown.length > 0 ? shown : accounts.slice(0, 1);
	});
	const folded = $derived(accounts.filter((reading) => !docked.includes(reading)));
	const single = $derived(accounts.length === 1 ? accounts.find((reading) => reading.windows.some((window) => window.kind in windowLabels)) : undefined);
	let sheetOpen = $state(false);

	function groupsOf(rows: readonly UsageReading[]) {
		return harnesses.flatMap((harness) => {
			const group = rows.filter((row) => row.harness === harness);
			if (group.length === 0) return [];
			const columns = kinds.filter((kind) => group.some((row) => row.windows.some((window) => window.kind === kind)));
			return [{ harness, rows: group, columns: columns.length > 0 ? columns : harness === "cursor" ? ["month" as const] : ["five_hour" as const, "seven_day" as const] }];
		});
	}

	function displayWindow(reading: UsageReading, window: UsageWindow) {
		// A limited 5h window must not turn a healthy week red.
		const display = usageDisplay({ ...reading, status: window.utilization >= 100 ? "limited" : "available", windows: [window] }, usageState.limits.warnAt);
		const percentage = `${Math.round(window.utilization)}%`;
		return {
			...display,
			label: window.kind === "five_hour" && display.level === "limited"
				? display.label.match(/\d{1,2}:\d{2}/)?.[0] ?? percentage
				: percentage,
		};
	}
</script>

{#snippet cell(prefix: string, reading: UsageReading, kind: WindowKind, width: number, gap: 4 | 5 = 4, layout = "")}
	{@const window = reading.windows.find((window) => window.kind === kind)}
	{@const display = window ? displayWindow(reading, window) : undefined}
	<span
		data-testid="{prefix}-cell-{reading.accountId}-{kind}"
		data-level={display?.level === "limited" ? "danger" : display?.level === "warn" ? "warning" : display?.level === "ok" ? "normal" : "unknown"}
		class="flex min-w-0 items-center whitespace-nowrap {layout}"
	>
		{#if window && display}
			<QuotaMeter
				used={window.utilization}
				warnAt={usageState.limits.warnAt}
				caption={display.label}
				variant="usage"
				trackWidth={width}
				{gap}
				trackTestId="{prefix}-bar-{reading.accountId}-{kind}"
				captionTestId="{prefix}-value-{reading.accountId}-{kind}"
			/>
		{:else}
			<span data-testid="{prefix}-value-{reading.accountId}-{kind}" class="font-mono text-[10.5px] text-text-dimmer">—</span>
		{/if}
	</span>
{/snippet}

<!-- The grid of harness groups. The desktop sidebar and the phone dock never
     show together, so they share test ids; the sheet opens over the dock. -->
{#snippet meter(rows: readonly UsageReading[], prefix: "usage-footer" | "usage-sheet", size: "sidebar" | "phone" | "sheet")}
	{@const rowClass = size === "sidebar" ? "account-row px-[6px] py-[3px]" : size === "phone" ? "phone-row px-[6px] py-[3px]" : "phone-row px-[8px] py-[6px] text-[12px]"}
	{@const widths = size === "sidebar" ? { pair: 26, span: 88 } : { pair: 44, span: 120 }}
	{#each groupsOf(rows) as group (group.harness)}
		<div data-testid="{prefix}-group-{group.harness}">
			<div class="{rowClass} grid items-center gap-[6px] rounded-[7px]">
				<span></span>
				<span data-testid="{prefix}-heading-{group.harness}" class="pt-[4px] font-mono text-[9px] uppercase tracking-[0.05em] text-text-dimmer">{group.harness.toUpperCase()}</span>
				{#each group.columns as kind, index (kind)}
					<span data-testid="{prefix}-column-{group.harness}-{kind}" class="pt-[4px] font-mono text-[9px] uppercase tracking-[0.05em] text-text-dimmer {group.columns.length === 1 ? 'spanning-window' : index === 1 ? 'second-window' : ''}">{windowLabels[kind].toUpperCase()}</span>
				{/each}
			</div>
			{#each group.rows as reading (reading.accountId)}
				{@const isDefault = reading.accountId === defaultAccount}
				<div data-testid="{prefix}-row-{reading.accountId}" data-default={isDefault} title={isDefault ? "Default for this project" : undefined} class="{rowClass} grid items-center gap-[6px] rounded-[7px] {isDefault ? 'bg-bg-alt' : ''}">
					<AccountDot instanceId={reading.accountId} size={7} data-testid="{prefix}-dot-{reading.accountId}" />
					<span data-testid="{prefix}-name-{reading.accountId}" class="min-w-0 truncate {isDefault ? 'text-text' : 'text-text-secondary'}">{getInstanceById(reading.accountId)?.name ?? reading.accountId}</span>
					{#each group.columns as kind, index (kind)}
						{@render cell(prefix, reading, kind, group.columns.length === 1 ? widths.span : widths.pair, 4, group.columns.length === 1 ? 'spanning-window' : index === 1 ? 'second-window' : '')}
					{/each}
				</div>
			{/each}
		</div>
	{/each}
{/snippet}

{#snippet singleLine(columnPrefix: string, abbreviateWeek: boolean)}
	{#if single}
		{#each kinds.filter((kind) => single.windows.some((window) => window.kind === kind)) as kind, index (kind)}
			<span class="flex min-w-0 items-center gap-[5px] {index === 1 ? 'second-window' : ''}">
				<span data-testid="{columnPrefix}-{kind}" class="text-text-muted">{abbreviateWeek && kind === "seven_day" ? "Wk" : windowLabels[kind]}</span>
				{@render cell("usage-footer", single, kind, kind === "seven_day" ? (abbreviateWeek ? 32 : 36) : 40, 5)}
			</span>
		{/each}
	{/if}
{/snippet}

{#if phone}
	<div
		id="usage-footer-phone"
		data-testid="usage-footer-phone"
		bind:clientHeight={height}
		style:display={accounts.length > 1 || single ? undefined : "none"}
		class="usage-phone-dock shrink-0 border-t border-border-subtle bg-bg px-[4px] pt-[5px] text-[10.5px]"
	>
		{#if single}
			<TextButton tone="inherit" data-testid="usage-phone-single" aria-label="Open Usage settings" onclick={() => openSettings("usage")} class="flex w-full items-center gap-[10px] whitespace-nowrap px-[10px] py-[6px] text-left">
				{@render singleLine("usage-phone-column", true)}
			</TextButton>
		{:else if accounts.length > 1}
			<TextButton
				tone="inherit"
				data-testid="usage-phone-dock"
				aria-label="Show usage for every account"
				aria-haspopup="dialog"
				onclick={() => { sheetOpen = true; }}
				class="flex w-full flex-col text-left"
			>
				<span aria-hidden="true" class="mx-auto mt-[2px] mb-[3px] h-[4px] w-[32px] rounded-full bg-border-chip"></span>
				{@render meter(docked, "usage-footer", "phone")}
				{#if folded.length > 0}
					<span data-testid="usage-phone-more" class="flex items-center gap-[4px] pt-[4px] pr-[6px] pl-[19px] font-mono text-[10px] text-text-dimmer">
						{#each folded as reading (reading.accountId)}
							<AccountDot instanceId={reading.accountId} size={6} data-testid="usage-phone-folded-{reading.accountId}" />
						{/each}
						<span data-testid="usage-phone-more-count" class="ml-[3px] flex-1">+{folded.length} more</span>
						<Icon name="chevron-up" size={12} />
					</span>
				{/if}
			</TextButton>
		{/if}
	</div>
	<Dialog open={sheetOpen} onclose={() => { sheetOpen = false; }} placement="sheet" labelledBy="{id}-title" returnFocus={() => document.querySelector<HTMLElement>('[data-testid="usage-phone-dock"]')}>
		<Surface variant="raised" radius="none" elevation="modal" data-testid="usage-sheet" class="w-full rounded-t-[18px] px-[8px] pt-[8px] pb-[calc(24px+env(safe-area-inset-bottom))] text-[11.5px]">
			<div aria-hidden="true" class="mx-auto mb-[8px] h-[4px] w-[36px] rounded-full bg-border-chip"></div>
			<div class="mx-[8px] mt-[2px] mb-[6px] flex items-baseline gap-[8px]">
				<h2 id="{id}-title" class="flex-1 text-[14px] font-semibold text-text">Usage</h2>
				<TextButton tone="accent" data-testid="usage-sheet-settings" onclick={() => { sheetOpen = false; openSettings("usage"); }}>Settings ›</TextButton>
			</div>
			{@render meter(accounts, "usage-sheet", "sheet")}
		</Surface>
	</Dialog>
{:else if single}
	<TextButton tone="inherit" data-testid="usage-footer-meter" aria-label="Open Usage settings" onclick={() => openSettings("usage")} class="shrink-0 border-t border-border-subtle p-[10px] text-left text-[10.5px]">
		<div data-testid="usage-footer-single" class="flex items-center gap-[10px] whitespace-nowrap">
			{@render singleLine(`usage-footer-column-${single.harness}`, false)}
		</div>
	</TextButton>
{:else if accounts.length > 1}
	<TextButton tone="inherit" data-testid="usage-footer-meter" aria-label="Open Usage settings" onclick={() => openSettings("usage")} class="flex shrink-0 flex-col border-t border-border-subtle px-[4px] pt-[5px] pb-[7px] text-left text-[10.5px]">
		{@render meter(accounts, "usage-footer", "sidebar")}
	</TextButton>
{/if}

<style>
	/* The page runs under the home indicator (viewport-fit=cover), so the dock
	   pads past it to the bottom edge. */
	.usage-phone-dock {
		padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
	}

	.account-row {
		grid-template-columns: 7px minmax(0, 1fr) 60px 58px;
	}

	.phone-row {
		grid-template-columns: 7px minmax(0, 1fr) 84px 84px;
	}

	.spanning-window {
		grid-column: span 2;
	}

	@container sidebar (width < 210px) {
		.account-row {
			grid-template-columns: 7px minmax(0, 1fr) 60px;
		}
		.second-window {
			display: none;
		}
		.spanning-window {
			grid-column: 3 / -1;
		}
	}
</style>
