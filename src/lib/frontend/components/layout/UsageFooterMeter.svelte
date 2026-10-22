<script lang="ts">
	import SheetChrome from "../ui/SheetChrome.svelte";
	import { flushSync } from "svelte";
	import type { UsageReading, UsageWindow } from "../../../contracts/limit-recovery.js";
	import { getProviderDriver } from "../../../contracts/provider-instance.js";
	import { DISMISS_FRACTION, FLICK_PX_PER_MS, placeSheet } from "../../actions/drag-to-dismiss.js";
	import { applyInstanceListResponse, getInstanceById } from "../../stores/instance.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { composerAccountId, orderedUsageAccounts, usageState } from "../../stores/usage.svelte.js";
	import { usageDisplay } from "../../utils/continuation.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import AccountDot from "../ui/AccountDot.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import Icon from "../ui/Icon.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import { openSettings } from "./chrome-actions.js";

	let { phone = false, height = $bindable(0) }: { phone?: boolean; height?: number } = $props();

	const harnesses = ["claude", "codex", "cursor"] as const;
	const harnessLabels = { claude: "Claude", codex: "Codex", cursor: "Cursor" } as const;
	const windowLabels = { five_hour: "5h", seven_day: "Week", month: "Month" } as const;
	type WindowKind = keyof typeof windowLabels;
	const kinds: readonly WindowKind[] = ["five_hour", "seven_day", "month"];
	const currentAccount = $derived(composerAccountId(sessionState.currentId ? findSession(sessionState.currentId) : undefined));
	const accounts = $derived(orderedUsageAccounts());
	// The phone docks the current account's row and any account that needs attention; the sheet has the rest.
	const docked = $derived.by(() => {
		const shown = accounts.filter((reading) => {
			if (reading.accountId === currentAccount) return true;
			const { level } = usageDisplay(reading, usageState.limits.warnAt);
			return level === "warn" || level === "limited";
		});
		return shown.length > 0 ? shown : accounts.slice(0, 1);
	});
	const folded = $derived(accounts.filter((reading) => !docked.includes(reading)));
	const single = $derived(accounts.length === 1 ? accounts.find((reading) => reading.windows.some((window) => window.kind in windowLabels)) : undefined);
	let sheetOpen = $state(false);
	let sheet: HTMLElement | undefined = $state();
	let dock: HTMLElement | undefined = $state();
	// The dock's grab handle promises a pull: past the slop, the sheet rises with the finger.
	const PULL_SLOP_PX = 16;
	let pull: { startY: number; lastY: number; lastTime: number; velocity: number; rising: boolean } | undefined;
	// A pull ends in a click on the dock, which must not reopen a sheet the release put away.
	let swallowClick = false;
	let defaultSaving = $state(false);

	async function makeDefault(instanceId: string) {
		if (defaultSaving || getInstanceById(instanceId)?.isDefault) return;
		defaultSaving = true;
		try {
			applyInstanceListResponse(await rpc("SetDefault", { instanceId }));
		} catch (error: unknown) {
			toastFailure("Failed to change default account", "warn")(error);
		} finally {
			defaultSaving = false;
		}
	}

	// The sheet folds into the dock rather than off screen: at its lowest, its top meets the dock's.
	function dockOffset() {
		if (!sheet || !dock) return 0;
		return Math.max(sheet.getBoundingClientRect().height - (innerHeight - dock.getBoundingClientRect().top), 0);
	}

	function pullDock(event: PointerEvent) {
		if (!pull) return;
		const travel = pull.startY - event.clientY - PULL_SLOP_PX;
		if (!pull.rising) {
			if (travel <= 0) return;
			pull.rising = swallowClick = true;
			// Mount the sheet now, so it is placed under the finger before the next paint.
			flushSync(() => { sheetOpen = true; });
		}
		const elapsed = event.timeStamp - pull.lastTime;
		if (elapsed > 0) pull.velocity = (event.clientY - pull.lastY) / elapsed;
		pull.lastY = event.clientY;
		pull.lastTime = event.timeStamp;
		if (sheet) placeSheet(sheet, Math.max(dockOffset() - travel, 0), dockOffset(), false);
	}

	// A tap raises the sheet out of the dock, the way a pull does.
	function openSheet() {
		flushSync(() => { sheetOpen = true; });
		if (!sheet) return;
		placeSheet(sheet, dockOffset(), dockOffset(), false);
		placeSheet(sheet, 0, dockOffset(), true);
	}

	function releaseDock(cancelled: boolean) {
		const ended = pull;
		pull = undefined;
		if (!ended?.rising || !sheet) return;
		const travel = ended.startY - ended.lastY - PULL_SLOP_PX;
		const away = dockOffset();
		const opens = !cancelled && (travel > away * DISMISS_FRACTION || ended.velocity < -FLICK_PX_PER_MS);
		const glideMs = placeSheet(sheet, opens ? 0 : away, away, true);
		if (!opens) setTimeout(() => { sheetOpen = false; }, glideMs);
	}

	function groupsOf(rows: readonly UsageReading[]) {
		return harnesses.flatMap((harness) => {
			const group = rows.filter((row) => row.harness === harness);
			if (group.length === 0) return [];
			const columns = kinds.filter((kind) => group.some((row) => row.windows.some((window) => window.kind === kind)));
			return [{ harness, rows: group, columns: columns.length > 0 ? columns : harness === "cursor" ? ["month" as const] : ["five_hour" as const, "seven_day" as const] }];
		});
	}

	// Raised, the sheet's rest carries on the dock's last group rather than repeating its heading.
	const continuedHarness = $derived.by(() => {
		const above = groupsOf(docked).at(-1);
		const below = groupsOf(folded)[0];
		return above && below && above.harness === below.harness && above.columns.join() === below.columns.join() ? below.harness : undefined;
	});

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

{#snippet defaultMarker(prefix: string, accountId: string)}
	{#if getInstanceById(accountId)?.isDefault}
		<span data-testid="{prefix}-default-{accountId}" class="shrink-0 text-text-muted" title="Default account" aria-label="Default account"><Icon name="star" size={10} /></span>
	{/if}
{/snippet}

{#snippet cell(prefix: string, reading: UsageReading, kind: WindowKind, layout = "")}
	{@const window = reading.windows.find((window) => window.kind === kind)}
	{@const display = window && !reading.stale && reading.status !== "unknown" && reading.status !== "unavailable" ? displayWindow(reading, window) : undefined}
	<span
		data-testid="{prefix}-cell-{reading.accountId}-{kind}"
		data-level={display?.level === "limited" ? "danger" : display?.level === "warn" ? "warning" : display?.level === "ok" ? "normal" : "unknown"}
		class="flex min-w-0 items-center whitespace-nowrap {layout}"
	>
		<QuotaMeter
			used={display && window ? window.utilization : "unknown"}
			warnAt={usageState.limits.warnAt}
			caption={display?.label ?? "—"}
			variant="usage"
			trackWidth={layout === "spanning-window" ? 88 : 26}
			gap={6}
			trackTestId="{prefix}-bar-{reading.accountId}-{kind}"
			captionTestId="{prefix}-value-{reading.accountId}-{kind}"
		/>
	</span>
{/snippet}

<!-- The grid of harness groups. The desktop sidebar and the phone dock never
     show together, so they share test ids; the sheet opens over the dock. -->
{#snippet meter(rows: readonly UsageReading[], prefix: "usage-footer" | "usage-sheet", size: "sidebar" | "phone", continues?: string)}
	{@const rowClass = "account-row px-[6px]"}
	{#each groupsOf(rows) as group, groupIndex (group.harness)}
		<div data-testid="{prefix}-group-{group.harness}" class="meter-group w-full {groupIndex > 0 ? 'mt-[6px]' : ''}">
			{#if group.harness !== continues && (size === "sidebar" || prefix === "usage-sheet")}
				<div class="{rowClass} grid items-center gap-[6px] text-text-dimmer {size === 'sidebar' ? 'h-[22px] text-[11.5px]' : 'h-[28px] text-[12.5px]'}">
					<span data-testid="{prefix}-heading-{group.harness}" class="font-semibold text-text-secondary">{harnessLabels[group.harness]}</span>
					{#each group.columns as kind, index (kind)}
						<span data-testid="{prefix}-column-{group.harness}-{kind}" class="{group.columns.length === 1 ? 'spanning-window' : index === 1 ? 'second-window' : ''}">{windowLabels[kind]}</span>
					{/each}
				</div>
			{/if}
			{#each group.rows as reading (reading.accountId)}
				<!-- data-default retains the current-account highlight; the star uses the instance's isDefault. -->
				{@const isDefault = reading.accountId === currentAccount}
				{@const accountName = getInstanceById(reading.accountId)?.name ?? reading.accountId}
				{@const interactive = size === "sidebar" || prefix === "usage-sheet"}
				{@const canSelect = interactive && getProviderDriver(getInstanceById(reading.accountId)?.driver)?.defaultAccountSource === "selection"}
				{#snippet rowContent()}
					<span class="flex min-w-0 items-center gap-[6px]">
						<AccountDot instanceId={reading.accountId} size={7} data-testid="{prefix}-dot-{reading.accountId}" />
						<span data-testid="{prefix}-name-{reading.accountId}" class="min-w-0 truncate {isDefault ? 'text-text' : 'text-text-secondary'}">{accountName}</span>
						{@render defaultMarker(prefix, reading.accountId)}
					</span>
					{#each group.columns as kind, index (kind)}
						{@render cell(prefix, reading, kind, group.columns.length === 1 ? 'spanning-window' : index === 1 ? 'second-window' : '')}
					{/each}
				{/snippet}
				{#if canSelect}
					<TextButton tone="inherit" data-testid="{prefix}-row-{reading.accountId}" data-default={isDefault} title={isDefault ? "Current account" : undefined} aria-label="Make {accountName} the default {harnessLabels[group.harness]} account" onclick={() => makeDefault(reading.accountId)} class="{rowClass} grid w-full items-center gap-[6px] rounded-[7px] text-left {prefix === 'usage-sheet' ? 'h-[34px] text-[14px]' : size === 'phone' ? 'h-[30px] text-[13px]' : 'h-[24px] text-[12px]'} {isDefault ? 'bg-chip' : ''}">
						{@render rowContent()}
					</TextButton>
				{:else}
					<div data-testid="{prefix}-row-{reading.accountId}" data-default={isDefault} title={isDefault ? "Current account" : undefined} class="{rowClass} grid w-full items-center gap-[6px] rounded-[7px] text-left {prefix === 'usage-sheet' ? 'h-[34px] text-[14px]' : size === 'phone' ? 'h-[30px] text-[13px]' : 'h-[24px] text-[12px]'} {isDefault ? 'bg-chip' : ''}">
						{@render rowContent()}
					</div>
				{/if}
			{/each}
		</div>
	{/each}
{/snippet}

<!-- The dock and sheet share account contents; sheet chrome is owned separately. -->
{#snippet peek(prefix: "usage-footer" | "usage-sheet")}
	{@const morePrefix = prefix === "usage-footer" ? "usage-phone" : "usage-sheet"}
	{#if prefix === "usage-footer"}<span aria-hidden="true" class="mx-auto mt-[-4px] mb-[8px] h-[5px] w-[36px] rounded-full bg-border-chip"></span>{/if}
	{@render meter(docked, prefix, "phone")}
	{#if folded.length > 0}
		<!-- Its height is the distance the sheet's rest slides up to close the gap it leaves. -->
		<span data-testid="{morePrefix}-more" aria-hidden={prefix === "usage-sheet" || undefined} class="flex h-[28px] items-center gap-[6px] px-[6px] text-[12.5px] text-text-dimmer {prefix === 'usage-sheet' ? 'sheet-fades' : ''}">
			<span data-testid="{morePrefix}-more-count">{folded.length === 1 && folded[0] ? `+1 ${harnessLabels[folded[0].harness]} account` : `+${folded.length} more`}</span>
			{#each folded as reading (reading.accountId)}
				<AccountDot instanceId={reading.accountId} size={6} data-testid="{morePrefix}-folded-{reading.accountId}" />
			{/each}
			<span class="ml-auto"><Icon name="chevron-right" size={13} /></span>
		</span>
	{/if}
{/snippet}

{#snippet singleLine(columnPrefix: string)}
	{#if single}
		<span data-testid="usage-footer-harness" class="mr-auto font-semibold text-text-secondary">{harnessLabels[single.harness]}</span>
		{#each kinds.filter((kind) => single.windows.some((window) => window.kind === kind)) as kind, index (kind)}
			<span class="flex min-w-0 items-center gap-[5px] {index === 1 ? 'second-window' : ''}">
				<span data-testid="{columnPrefix}-{kind}" class="text-text-dimmer">{windowLabels[kind]}</span>
				{@render cell("usage-footer", single, kind)}
			</span>
		{/each}
	{/if}
{/snippet}

{#if phone}
	<div
		id="usage-footer-phone"
		bind:this={dock}
		data-testid="usage-footer-phone"
		bind:clientHeight={height}
		style:display={accounts.length > 1 || single ? undefined : "none"}
		class="usage-phone-dock shrink-0 rounded-t-[18px] border-t border-border-subtle bg-sidebar-bg px-[12px] pt-[12px] text-[13px]"
	>
		{#if single}
			<TextButton tone="inherit" data-testid="usage-phone-single" aria-label="Open Usage settings" onclick={() => openSettings("usage")} class="flex min-h-[44px] w-full items-center gap-[8px] whitespace-nowrap px-[6px] text-left text-[11.5px]">
				{@render singleLine("usage-phone-column")}
			</TextButton>
		{:else if accounts.length > 1}
			<TextButton
				tone="inherit"
				data-testid="usage-phone-dock"
				aria-label="Show usage for every account"
				aria-haspopup="dialog"
				onclick={() => {
					if (swallowClick) swallowClick = false;
					else openSheet();
				}}
				onpointerdown={(event: PointerEvent) => {
					if (!event.isPrimary) return;
					swallowClick = false;
					pull = { startY: event.clientY, lastY: event.clientY, lastTime: event.timeStamp, velocity: 0, rising: false };
					// A mouse keeps reporting once it leaves the dock; a finger is captured already.
					if (event.currentTarget instanceof Element) event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onpointermove={pullDock}
				onpointerup={() => releaseDock(false)}
				onpointercancel={() => releaseDock(true)}
				class="flex w-full touch-none flex-col text-left"
			>
				{@render peek("usage-footer")}
			</TextButton>
		{/if}
	</div>
	<Dialog open={sheetOpen} onclose={() => { sheetOpen = false; }} placement="sheet" bind:sheetElement={sheet} sheetDismissOffset={dockOffset} ariaLabel="Usage" returnFocus={() => document.querySelector<HTMLElement>('[data-testid="usage-phone-dock"]')}>
			<SheetChrome data-testid="usage-sheet" bottomPadding={16} class="text-[10.5px]" bodyClass="px-[4px]">
				{@render peek("usage-sheet")}
				<div class={folded.length > 0 ? "sheet-rest" : undefined}>
					{@render meter(folded, "usage-sheet", "phone", continuedHarness)}
					<div class="mx-[6px] mt-[10px] flex items-center justify-between border-t border-border-subtle pt-[8px] text-[12.5px] text-text-muted">
						<span>{accounts.length} accounts</span>
						<TextButton tone="accent" data-testid="usage-sheet-settings" onclick={() => { sheetOpen = false; openSettings("usage"); }} class="min-h-[44px] font-medium">Usage settings ›</TextButton>
					</div>
				</div>
			</SheetChrome>
	</Dialog>
{:else if single || accounts.length > 1}
	<div data-testid="usage-footer-meter" class="flex shrink-0 flex-col border-t border-border-subtle px-[8px] pt-[8px] pb-[10px] text-left text-[12px]">
		{#if single}
			<!-- A lone account is already its harness default, so the row is not a button. -->
			<div data-testid="usage-footer-single" class="flex h-[26px] items-center gap-[8px] whitespace-nowrap px-[6px] text-[11.5px]">
				{@render singleLine(`usage-footer-column-${single.harness}`)}
				{@render defaultMarker("usage-footer", single.accountId)}
			</div>
		{:else}
			{@render meter(accounts, "usage-footer", "sidebar")}
		{/if}
		<TextButton tone="accent" data-testid="usage-footer-settings" onclick={() => openSettings("usage")} class="mt-[6px] self-end px-[6px] text-[11.5px]">Usage settings ›</TextButton>
	</div>
{/if}

<style>
	/* The page runs under the home indicator (viewport-fit=cover), so the dock
	   pads past it to the bottom edge. */
	.usage-phone-dock {
		padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
	}

	/* Rows can be TextButtons, whose root misses this component's scoped class. */
	.meter-group :global(.account-row) {
		grid-template-columns: minmax(0, 1fr) 66px 62px;
	}

	.spanning-window {
		grid-column: span 2;
	}

	/* The "+N more" line only makes sense folded: as the sheet rises it fades,
	   and the rest of the accounts slide up into its place, so the raised sheet
	   reads as one list. It is gone a third of the way up, before the rows
	   sliding over it get close. */
	.sheet-fades {
		opacity: calc(1 - 3 * var(--sheet-raised, 1));
		transition: opacity var(--sheet-transition, 0s);
	}

	.sheet-rest {
		translate: 0 calc(var(--sheet-raised, 1) * -28px);
		transition: translate var(--sheet-transition, 0s);
	}

	@container sidebar (width < 210px) {
		.meter-group :global(.account-row) {
			grid-template-columns: minmax(0, 1fr) 66px;
		}
		.second-window {
			display: none;
		}
		.spanning-window {
			grid-column: 2 / -1;
		}
	}
</style>
