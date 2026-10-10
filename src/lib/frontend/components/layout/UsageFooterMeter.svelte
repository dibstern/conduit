<script lang="ts">
	import type { UsageReading, UsageWindow } from "../../../contracts/limit-recovery.js";
	import { getInstanceById, instanceState } from "../../stores/instance.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { usageState } from "../../stores/usage.svelte.js";
	import { usageDisplay } from "../../utils/continuation.js";
	import AccountDot from "../ui/AccountDot.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";

	const harnesses = ["claude", "codex", "cursor"] as const;
	const windowLabels = { five_hour: "5h", seven_day: "Week", month: "Month" } as const;
	type WindowKind = keyof typeof windowLabels;
	const kinds: readonly WindowKind[] = ["five_hour", "seven_day", "month"];
	const defaultAccount = $derived(projectState.projects.find((project) => project.slug === getCurrentSlug())?.instanceId);
	const accounts = $derived.by(() => {
		const order = usageState.order;
		const rank = (id: string) => {
			const index = order.indexOf(id);
			return index === -1 ? order.length : index;
		};
		return usageState.readings.filter((reading) => {
			const instance = getInstanceById(reading.accountId);
			if (!instance) return false;
			const env = instance.env;
			return reading.harness !== "claude" || (!env?.["ANTHROPIC_API_KEY"] && !env?.["ANTHROPIC_AUTH_TOKEN"]);
		}).sort((a, b) => rank(a.accountId) - rank(b.accountId) || instanceState.instances.findIndex((instance) => instance.id === a.accountId) - instanceState.instances.findIndex((instance) => instance.id === b.accountId));
	});
	const groups = $derived(harnesses.flatMap((harness) => {
		const rows = accounts.filter((account) => account.harness === harness);
		if (rows.length === 0) return [];
		const columns = kinds.filter((kind) => rows.some((row) => row.windows.some((window) => window.kind === kind)));
		return [{ harness, rows, columns: columns.length > 0 ? columns : harness === "cursor" ? ["month" as const] : ["five_hour" as const, "seven_day" as const] }];
	}));

	function displayWindow(reading: UsageReading, window: UsageWindow) {
		// A limited 5h window must not turn a healthy week red.
		const display = usageDisplay({ ...reading, status: window.utilization >= 100 ? "limited" : "available", windows: [window] });
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

{#if accounts.length === 1}
	{@const reading = accounts[0]}
	{#if reading && reading.windows.some((window) => window.kind in windowLabels)}
		<div data-testid="usage-footer-meter" class="shrink-0 border-t border-border-subtle p-[10px] text-[10.5px]">
			<div data-testid="usage-footer-single" class="flex items-center gap-[10px] whitespace-nowrap">
				{#each kinds.filter((kind) => reading.windows.some((window) => window.kind === kind)) as kind, index (kind)}
					<span class="flex min-w-0 items-center gap-[5px] {index === 1 ? 'second-window' : ''}">
						<span data-testid="usage-footer-column-{reading.harness}-{kind}" class="text-text-muted">{windowLabels[kind]}</span>
						{@render cell(reading, kind, kind === "seven_day" ? 36 : 40, 5)}
					</span>
				{/each}
			</div>
		</div>
	{/if}
{:else if accounts.length > 1}
	<div data-testid="usage-footer-meter" class="flex shrink-0 flex-col border-t border-border-subtle px-[4px] pt-[5px] pb-[7px] text-[10.5px]">
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
	</div>
{/if}

<style>
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
