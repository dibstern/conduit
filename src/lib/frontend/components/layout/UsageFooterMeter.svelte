<script lang="ts">
	import type { UsageReading, UsageWindow } from "../../../contracts/limit-recovery.js";
	import { getInstanceById } from "../../stores/instance.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { orderedUsageAccounts, usageState } from "../../stores/usage.svelte.js";
	import { usageDisplay } from "../../utils/continuation.js";
	import AccountDot from "../ui/AccountDot.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import { openSettings } from "./chrome-actions.js";

	let { phone = false, height = $bindable(0) }: { phone?: boolean; height?: number } = $props();

	const harnesses = ["claude", "codex", "cursor"] as const;
	const windowLabels = { five_hour: "5h", seven_day: "Week", month: "Month" } as const;
	const phoneWindowLabels = { five_hour: "5h", seven_day: "wk", seven_day_model: "wk", month: "mo" } as const;
	type WindowKind = keyof typeof windowLabels;
	const kinds: readonly WindowKind[] = ["five_hour", "seven_day", "month"];
	const defaultAccount = $derived(projectState.projects.find((project) => project.slug === getCurrentSlug())?.instanceId);
	const accounts = $derived(orderedUsageAccounts());
	const groups = $derived(harnesses.flatMap((harness) => {
		const rows = accounts.filter((account) => account.harness === harness);
		if (rows.length === 0) return [];
		const columns = kinds.filter((kind) => rows.some((row) => row.windows.some((window) => window.kind === kind)));
		return [{ harness, rows, columns: columns.length > 0 ? columns : harness === "cursor" ? ["month" as const] : ["five_hour" as const, "seven_day" as const] }];
	}));
	const phoneChips = $derived.by(() => {
		const chips = accounts.flatMap((reading) => {
			const isDefault = reading.accountId === defaultAccount;
			// The default chip shows its fuller window; another account only gets a chip when its binding window warns.
			const { level, binding } = usageDisplay(reading, isDefault ? "off" : usageState.limits.warnAt);
			if (!isDefault && level !== "warn" && level !== "limited") return [];
			return [{ reading, isDefault, binding, display: binding ? displayWindow(reading, binding) : undefined }];
		});
		return [...chips.filter((chip) => chip.isDefault), ...chips.filter((chip) => !chip.isDefault)];
	});
	const phoneRemaining = $derived(accounts.length - phoneChips.length);
	const phoneSingle = $derived(accounts.length === 1 && accounts[0]?.windows.some((window) => window.kind in windowLabels));

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

{#snippet cell(reading: UsageReading, kind: WindowKind, width: number, gap: 4 | 5 = 4, layout = "")}
	{@const window = reading.windows.find((window) => window.kind === kind)}
	{@const display = window ? displayWindow(reading, window) : undefined}
	<span
		data-testid="usage-footer-cell-{reading.accountId}-{kind}"
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
				trackTestId="usage-footer-bar-{reading.accountId}-{kind}"
				captionTestId="usage-footer-value-{reading.accountId}-{kind}"
			/>
		{:else}
			<span data-testid="usage-footer-value-{reading.accountId}-{kind}" class="font-mono text-[10.5px] text-text-dimmer">—</span>
		{/if}
	</span>
{/snippet}

{#if phone}
	<div
		id="usage-footer-phone"
		data-testid="usage-footer-phone"
		bind:clientHeight={height}
		style:display={accounts.length > 1 || phoneSingle ? undefined : "none"}
		class="usage-phone-footer pointer-events-none absolute left-0 right-[66px] z-[var(--z-raised)] flex flex-wrap items-center gap-[10px] px-[14px] py-[16px] text-[10.5px]"
	>
		{#if accounts.length === 1 && phoneSingle}
			{@const reading = accounts[0]}
			{#if reading}
				<TextButton tone="inherit" data-testid="usage-phone-single" aria-label="Open Usage settings" onclick={() => openSettings("usage")} class="pointer-events-auto flex flex-wrap items-center gap-[10px] whitespace-nowrap text-left">
					{#each kinds.filter((kind) => reading.windows.some((window) => window.kind === kind)) as kind, index (kind)}
						{#if index > 0}<span aria-hidden="true" class="text-text-dimmer">·</span>{/if}
						<span class="flex min-w-0 items-center gap-[5px]">
							<span data-testid="usage-phone-column-{kind}" class="text-text-muted">{kind === "seven_day" ? "Wk" : windowLabels[kind]}</span>
							{@render cell(reading, kind, kind === "seven_day" ? 32 : 40, 5)}
						</span>
					{/each}
				</TextButton>
			{/if}
		{:else if accounts.length > 1}
			{#each phoneChips as { reading, isDefault, binding, display } (reading.accountId)}
				<TextButton
					tone="inherit"
					type="button"
					aria-label="Open Usage settings for {getInstanceById(reading.accountId)?.name ?? reading.accountId}"
					onclick={() => openSettings("usage")}
					data-testid="usage-phone-chip-{reading.accountId}"
					data-account={reading.accountId}
					data-default={isDefault}
					data-level={display?.level ?? "unknown"}
					title={isDefault ? "Default for this project" : getInstanceById(reading.accountId)?.name ?? reading.accountId}
					class="pointer-events-auto inline-flex h-[22px] items-center gap-[4px] rounded-full px-[7px] {isDefault ? 'bg-bg-alt' : ''}"
				>
					<AccountDot instanceId={reading.accountId} size={7} data-testid="usage-phone-dot-{reading.accountId}" />
					{#if binding}
						<span data-testid="usage-phone-window-{reading.accountId}" class="font-mono text-text-dimmer">{phoneWindowLabels[binding.kind]}</span>
					{/if}
					<span data-testid="usage-phone-value-{reading.accountId}" class="whitespace-nowrap font-mono {display?.level === 'limited' ? 'text-error' : display?.level === 'warn' ? 'text-fill-amber' : display ? 'text-text-secondary' : 'text-text-dimmer'}">{display?.label ?? "—"}</span>
				</TextButton>
			{/each}
			{#if phoneRemaining > 0}
				<TextButton tone="dimmer" data-testid="usage-phone-more" aria-label="Open Usage settings for all accounts" onclick={() => openSettings("usage")} class="pointer-events-auto inline-flex h-[22px] items-center rounded-full px-[7px] font-mono">+{phoneRemaining}</TextButton>
			{/if}
		{/if}
	</div>
{:else if accounts.length === 1}
	{@const reading = accounts[0]}
	{#if reading && reading.windows.some((window) => window.kind in windowLabels)}
		<TextButton tone="inherit" data-testid="usage-footer-meter" aria-label="Open Usage settings" onclick={() => openSettings("usage")} class="shrink-0 border-t border-border-subtle p-[10px] text-left text-[10.5px]">
			<div data-testid="usage-footer-single" class="flex items-center gap-[10px] whitespace-nowrap">
				{#each kinds.filter((kind) => reading.windows.some((window) => window.kind === kind)) as kind, index (kind)}
					<span class="flex min-w-0 items-center gap-[5px] {index === 1 ? 'second-window' : ''}">
						<span data-testid="usage-footer-column-{reading.harness}-{kind}" class="text-text-muted">{windowLabels[kind]}</span>
						{@render cell(reading, kind, kind === "seven_day" ? 36 : 40, 5)}
					</span>
				{/each}
			</div>
		</TextButton>
	{/if}
{:else if accounts.length > 1}
	<TextButton tone="inherit" data-testid="usage-footer-meter" aria-label="Open Usage settings" onclick={() => openSettings("usage")} class="flex shrink-0 flex-col border-t border-border-subtle px-[4px] pt-[5px] pb-[7px] text-left text-[10.5px]">
		{#each groups as group (group.harness)}
			<div data-testid="usage-footer-group-{group.harness}">
				<div class="account-row grid items-center gap-[6px] rounded-[7px] px-[6px] py-[3px]">
					<span></span>
					<span data-testid="usage-footer-heading-{group.harness}" class="pt-[4px] font-mono text-[9px] uppercase tracking-[0.05em] text-text-dimmer">{group.harness.toUpperCase()}</span>
					{#each group.columns as kind, index (kind)}
						<span data-testid="usage-footer-column-{group.harness}-{kind}" class="pt-[4px] font-mono text-[9px] uppercase tracking-[0.05em] text-text-dimmer {group.columns.length === 1 ? 'spanning-window' : index === 1 ? 'second-window' : ''}">{windowLabels[kind].toUpperCase()}</span>
					{/each}
				</div>
				{#each group.rows as reading (reading.accountId)}
					{@const isDefault = reading.accountId === defaultAccount}
					<div data-testid="usage-footer-row-{reading.accountId}" data-default={isDefault} title={isDefault ? "Default for this project" : undefined} class="account-row grid items-center gap-[6px] rounded-[7px] px-[6px] py-[3px] {isDefault ? 'bg-bg-alt' : ''}">
						<AccountDot instanceId={reading.accountId} size={7} data-testid="usage-footer-dot-{reading.accountId}" />
						<span data-testid="usage-footer-name-{reading.accountId}" class="min-w-0 truncate {isDefault ? 'text-text' : 'text-text-secondary'}">{getInstanceById(reading.accountId)?.name ?? reading.accountId}</span>
						{#each group.columns as kind, index (kind)}
							{@render cell(reading, kind, group.columns.length === 1 ? 88 : 26, 4, group.columns.length === 1 ? 'spanning-window' : index === 1 ? 'second-window' : '')}
						{/each}
					</div>
				{/each}
			</div>
		{/each}
	</TextButton>
{/if}

<style>
	.usage-phone-footer {
		bottom: calc(9px + env(safe-area-inset-bottom, 0px));
		background: linear-gradient(transparent, var(--color-bg) 40%);
	}

	.account-row {
		grid-template-columns: 7px minmax(0, 1fr) 60px 58px;
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
