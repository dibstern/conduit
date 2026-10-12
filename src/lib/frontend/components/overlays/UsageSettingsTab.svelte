<script lang="ts">
	import { MediaQuery } from "svelte/reactivity";
	import type { UsageLimitsSetting, UsageReading, UsageWindow } from "../../../contracts/limit-recovery.js";
	import { getClaudeAccounts } from "../../stores/claude-accounts.svelte.js";
	import { getEffectiveInstanceId, getSessionInstanceId } from "../../stores/discovery.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { applyUsageLimitsSetting, orderedSettingsUsageAccounts, usageAlert, usageState } from "../../stores/usage.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { getUsageLimitsSettingRpc, setUsageLimitsSettingRpc } from "../../transport/ws-rpc-client.js";
	import { usageDisplay, usageForecastDuration, usageForecastTime, usageForecastWindow, usagePaceLine, usageResetTime } from "../../utils/continuation.js";
	import AccountDot from "../ui/AccountDot.svelte";
	import Button from "../ui/Button.svelte";
	import SortableList from "../ui/SortableList.svelte";
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import UsageForecast from "./UsageForecast.svelte";
	import UsageLimitsSettings from "./UsageLimitsSettings.svelte";

	const phone = new MediaQuery("(max-width: 767px)");
	const warnOptions = [70, 80, 90, "off"] as const;
	const project = $derived(projectState.projects.find((item) => item.slug === getCurrentSlug()));
	const refreshSlug = $derived(project?.slug ?? projectState.projects[0]?.slug);
	const claudeAccounts = $derived(getClaudeAccounts(refreshSlug ?? ""));
	const accounts = $derived(orderedSettingsUsageAccounts());
	const several = $derived(accounts.length > 1);
	const single = $derived(accounts[0]);
	const sessionId = $derived(getCurrentSessionId());
	const sessionAccountId = $derived(sessionId ? getSessionInstanceId(sessionId) : undefined);
	const forecastAccount = $derived(sessionId
		? accounts.find((account) => account.accountId === sessionAccountId)
		: accounts.find((account) => account.accountId === getEffectiveInstanceId()) ?? accounts.reduce<UsageReading | undefined>((fullest, account) =>
			!fullest || (usageDisplay(account, "off").binding?.utilization ?? -1) > (usageDisplay(fullest, "off").binding?.utilization ?? -1) ? account : fullest, undefined));
	let expandedAccounts = $state<string[]>([]);
	let setting = $state<UsageLimitsSetting | null>(null);
	let confirmed: UsageLimitsSetting | null = null;
	let saveTicket = 0;
	let refreshing = $state(false);
	let now = $state(Date.now());
	const readAt = $derived(Math.min(...accounts.map((account) => account.readAt).filter((at) => at > 0)));
	const updated = $derived(Number.isFinite(readAt) ? Math.floor(Math.max(0, now - readAt) / 60_000) : null);
	const updatedLabel = $derived(updated === null ? "not read yet" : updated === 0 ? "just now" : `${updated}m ago`);
	const nameOf = (account: UsageReading) => claudeAccounts.nameOf(account.accountId, account.accountId);

	$effect(() => {
		const timer = setInterval(() => { now = Date.now(); }, 30_000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (!getIsConnected()) return;
		let current = true;
		void getUsageLimitsSettingRpc()
			.then((loaded) => {
				applyUsageLimitsSetting(loaded);
				if (current && saveTicket === 0) setting = confirmed = loaded;
			})
			.catch(() => {
				if (current) showToast("Couldn't load usage limit settings", { variant: "error" });
			});
		return () => { current = false; };
	});

	async function save(next: UsageLimitsSetting): Promise<void> {
		if (!setting) return;
		const ticket = ++saveTicket;
		setting = next;
		applyUsageLimitsSetting(next);
		try {
			confirmed = await setUsageLimitsSettingRpc(next);
			if (ticket === saveTicket) setting = confirmed;
		} catch {
			if (ticket === saveTicket) setting = confirmed;
			showToast("Couldn't save usage limit settings", { variant: "error" });
		}
		if (setting) applyUsageLimitsSetting(setting);
	}

	async function refresh(): Promise<void> {
		if (!refreshSlug || refreshing) return;
		refreshing = true;
		try {
			// Usage.refresh publishes through SubscribeUsage, which owns the view.
			if (!await claudeAccounts.refreshQuotas()) showToast("Couldn't refresh plan usage", { variant: "error" });
		} finally {
			refreshing = false;
		}
	}

	function hasPlanData(account: UsageReading | undefined): boolean {
		return account !== undefined && account.status !== "unknown" && account.status !== "unavailable" &&
			account.windows.some((window) => window.kind === "five_hour" || window.kind === "seven_day");
	}

	function resetLine(window: UsageWindow | undefined, full: boolean): string {
		if (!window || (window.kind === "five_hour" && window.utilization === 0 && !window.resetsAt)) return "no window open";
		const time = usageResetTime(window.resetsAt, window.kind === "seven_day");
		if (!time) return window.utilization >= 100 ? "limit reached" : "reset time unavailable";
		if (window.kind === "seven_day") return `resets ${time}`;
		if (window.utilization >= 100) return full ? `limit reached · resets ${time}` : `resets ${time}`;
		const minutes = Math.max(0, Math.ceil((Date.parse(window.resetsAt ?? "") - now) / 60_000));
		const remaining = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
		return `resets in ${remaining}${full ? ` (${time})` : ""}`;
	}

	function limitWindow(account: UsageReading): UsageWindow | undefined {
		// Warnings may bind to the week; only exhausted windows set a limit's reset.
		return account.windows
			.filter((window) => (window.kind === "five_hour" || window.kind === "seven_day") && window.utilization >= 100)
			.sort((a, b) => (Date.parse(b.resetsAt ?? "") || 0) - (Date.parse(a.resetsAt ?? "") || 0))[0]
			?? usageDisplay(account, usageState.limits.warnAt).binding;
	}

	function statusOf(account: UsageReading): string {
		if (!hasPlanData(account)) return "no plan data";
		const display = usageDisplay(account, usageState.limits.warnAt);
		if (display.level === "limited") {
			const time = usageResetTime(limitWindow(account)?.resetsAt).replace(/ (am|pm)$/, "");
			return time ? `limited · ${time}` : "limited";
		}
		return display.level === "warn" && display.binding
			? `${display.binding.kind === "seven_day" ? "week" : "5h"} ${Math.round(display.binding.utilization)}%`
			: "ok";
	}

	function nextAccount(account: UsageReading): UsageReading | undefined {
		return accounts.slice(accounts.indexOf(account) + 1).find((candidate) =>
			candidate.status !== "unavailable" && usageDisplay(candidate, usageState.limits.warnAt).level !== "limited");
	}

	const headline = $derived.by((): { text: string; limited: boolean; warning?: boolean; bold?: string } => {
		const defaultAccount = accounts.find((account) => account.accountId === (sessionId ? sessionAccountId : getEffectiveInstanceId())) ?? single;
		const alert = usageAlert(accounts, usageState.limits.warnAt);
		if (alert?.level === "limited") {
			const limited = alert.account;
			const time = usageResetTime(limitWindow(limited)?.resetsAt);
			let text = `${nameOf(limited)} is limited${time ? ` until ${time}` : ""}.`;
			const next = nextAccount(limited);
			const fiveHour = next?.windows.find((window) => window.kind === "five_hour");
			if (next && fiveHour) text += ` ${nameOf(next)}, next in the switch order, has ${Math.round(100 - fiveHour.utilization)}% of its 5h window left.`;
			return { text, limited: true };
		}
		if (alert?.level === "runs_out" && alert.window.forecast?.kind === "runs_out") {
			const { account, window } = alert;
			const forecast = alert.window.forecast;
			const kind = window.kind;
			const time = usageForecastTime(forecast.at, now);
			let bold = `${nameOf(account)} runs out of its ${kind === "seven_day" ? "week" : "5h window"} ≈ ${time}`;
			let rest = "";
			if (kind === "seven_day") {
				if (usageResetTime(window.resetsAt)) bold += `, ${usageForecastDuration(Date.parse(window.resetsAt ?? "") - forecast.at)} before it resets`;
				const others = accounts.filter((other) => other !== account && hasPlanData(other)).flatMap((other) => {
					const week = other.windows.find((window) => window.kind === "seven_day");
					return week ? [{ name: nameOf(other), left: Math.round(100 - week.utilization) }] : [];
				});
				if (others.length) rest = ` ${others.map((other, index) => `${other.name}${index === 0 ? " has" : ""} ${other.left}%${index === 0 ? " of its week left" : ""}`).join(", ")}.`;
			} else {
				const next = nextAccount(account);
				const fiveHour = next?.windows.find((window) => window.kind === "five_hour");
				if (next && fiveHour) rest = ` ${nameOf(next)}, next in the switch order, has ${Math.round(100 - fiveHour.utilization)}% of its 5h window left.`;
			}
			bold += ".";
			return { text: bold + rest, limited: false, warning: true, bold };
		}
		if (defaultAccount && !hasPlanData(defaultAccount)) {
			const names = accounts.filter((account) => account !== defaultAccount && hasPlanData(account)).map(nameOf);
			const others = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
			return { text: `${nameOf(defaultAccount)} has no plan data.${others ? ` ${others} ${names.length === 1 ? "is" : "are"} on pace to stay under their limits.` : ""}`, limited: false };
		}
		return { text: `All ${accounts.length} accounts are on pace to stay under their limits.`, limited: false };
	});
</script>

{#snippet meter(account: UsageReading, window: UsageWindow | undefined, label: string, prefix: string, full: boolean)}
	<!-- usageDisplay only rates account-wide windows, so a lone window is rated as one. -->
	{@const display = usageDisplay(window ? { ...account, status: window.utilization >= 100 ? "limited" : "available", windows: [{ ...window, kind: "seven_day" }] } : undefined, usageState.limits.warnAt)}
	<div class="mb-[3px] flex items-baseline gap-[6px] text-[11px]">
		<span data-testid="{prefix}-label" class="flex-1">{label}</span>
		<span data-testid="{prefix}-value" class="font-mono text-[10.5px] {display.level === 'limited' ? 'text-error' : display.level === 'warn' ? 'text-fill-amber' : 'text-text-secondary'}">{window ? `${Math.round(window.utilization)}%` : "—"}</span>
	</div>
	<div data-testid="{prefix}-bar" data-level={display.level} class="w-full overflow-hidden rounded-full bg-border-chip {full ? 'h-[6px]' : 'h-[5px]'}" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window?.utilization} aria-valuetext={window ? `${Math.round(window.utilization)}% used` : "no window open"}>
		<div class="h-full {display.colour}" style:width="{window?.utilization ?? 0}%"></div>
	</div>
{/snippet}

{#snippet windowRow(account: UsageReading, kind: "five_hour" | "seven_day", label: string, full: boolean)}
	{@const window = account.windows.find((item) => item.kind === kind)}
	{@const prefix = full ? `usage-settings-single-${kind}` : `usage-settings-card-${account.accountId}-${kind}`}
	<div class="min-w-0">
		{@render meter(account, window, label, prefix, full)}
		<div data-testid="{prefix}-reset" class="mt-[3px] font-mono text-[10.5px] text-text-dimmer">{resetLine(window, full)}</div>
	</div>
{/snippet}

<section id="usage-settings" data-testid="usage-settings" class="min-w-0" aria-label="Claude plan usage">
	{#if !phone.current}<h3 class="text-[14px] font-semibold text-text">Claude plan usage</h3>{/if}
	<div data-testid="usage-settings-subheader" class="mb-[12px] text-[11px] text-text-dimmer {phone.current ? '' : 'mt-[2px]'}">
		{#if !several && !hasPlanData(single)}Claude{:else}
		{several ? `${accounts.length} accounts` : single?.planLabel ?? claudeAccounts.nameOf(undefined)} · updated {updatedLabel} ·
		<TextButton tone="dimmer" underline="always" data-testid="usage-settings-refresh" disabled={refreshing || !refreshSlug} aria-busy={refreshing} onclick={refresh}>{several ? "Refresh all" : "Refresh"}</TextButton>
		{/if}
	</div>
	{#if several}
		<div id="usage-settings-headline" data-testid="usage-settings-headline" class="mb-[12px] rounded-[12px] border px-[12px] py-[8px] text-[12px] leading-[1.45] {headline.limited ? 'border-fill-red/40 bg-fill-red/[0.06] text-error' : headline.warning ? 'border-fill-amber/35 bg-fill-amber/[0.05] text-fill-amber' : 'border-border bg-bg text-text-secondary'}">{#if headline.bold}<b>{headline.bold}</b>{headline.text.slice(headline.bold.length)}{:else}{headline.text}{/if}</div>
		<SortableList items={accounts} key={(account) => account.accountId} label={nameOf} ariaLabel="Auto-switch account order" variant="cards" disabled={setting === null} onreorder={(next) => {
			if (setting) void save({ ...setting, order: next.map((account) => account.accountId) });
		}}>
			{#snippet row(account, index)}
				<span data-testid="usage-settings-position-{account.accountId}" class="font-mono text-[10.5px] text-text-dimmer">{index + 1}</span>
				<AccountDot instanceId={account.accountId} size={7} data-testid="usage-settings-dot-{account.accountId}" />
				<span data-testid="usage-limit-account-name" class="min-w-0 truncate font-semibold text-text">{nameOf(account)}</span>
				{#if hasPlanData(account) && account.planLabel}<span data-testid="usage-settings-plan-{account.accountId}" class="shrink-0 rounded-[5px] border border-border px-[4px] font-mono text-[9.5px] text-text-muted">{account.planLabel}</span>{/if}
				<span data-testid="usage-settings-status-{account.accountId}" class="ml-auto shrink-0 whitespace-nowrap font-mono text-[10.5px] {usageDisplay(account, usageState.limits.warnAt).level === 'limited' ? 'text-error' : usageDisplay(account, usageState.limits.warnAt).level === 'warn' ? 'text-fill-amber' : 'text-text-dimmer'}">{statusOf(account)}</span>
			{/snippet}
			{#snippet details(account)}
				{@const models = account.windows.flatMap((window) => window.kind === "seven_day_model" && window.model
					? [`${window.model} week ${Math.round(window.utilization)}%`] : [])}
				<div id="usage-settings-card-{account.accountId}" data-testid="usage-settings-card-{account.accountId}">
					{#if hasPlanData(account)}
						<div class="mt-[8px] grid gap-[10px] md:grid-cols-2 md:gap-[14px]">
							{@render windowRow(account, "five_hour", "5h", false)}
							{@render windowRow(account, "seven_day", "Week", false)}
						</div>
					{:else}<p class="mt-[6px] font-mono text-[10.5px] text-text-dimmer">No plan data for this login (API key, Bedrock, Vertex or proxy). Auto-switch can still pick it.</p>{/if}
					{#if models.length > 0}<div data-testid="usage-settings-models-{account.accountId}" class="mt-[7px] font-mono text-[10.5px] text-text-dimmer">{models.join(" · ")}</div>{/if}
					{#if usageForecastWindow(account)}
						{@const pace = usagePaceLine(account, now)}
						{#if account === forecastAccount || !pace}
							<UsageForecast {account} {now} />
						{:else}
								<Button variant="ghost" size="content" layout="flow" tone="muted" hoverFill="none" data-testid="usage-settings-pace-{account.accountId}" aria-expanded={expandedAccounts.includes(account.accountId)} aria-controls="usage-settings-forecast-{account.accountId}" class="mt-[6px] flex w-full items-start gap-[8px] text-left font-mono text-[10.5px]" onclick={() => {
									expandedAccounts = expandedAccounts.includes(account.accountId) ? expandedAccounts.filter((id) => id !== account.accountId) : [...expandedAccounts, account.accountId];
								}}><span class="min-w-0 flex-1">{pace}</span><span aria-hidden="true" class="text-text-dimmer">›</span></Button>
							{#if expandedAccounts.includes(account.accountId)}<UsageForecast {account} {now} />{/if}
						{/if}
					{/if}
				</div>
			{/snippet}
		</SortableList>
		<p data-testid="usage-settings-order-hint" class="mt-[6px] mb-[4px] font-mono text-[10.5px] text-text-dimmer">Drag ⠿ to set the auto-switch order.</p>
	{:else if single && (hasPlanData(single) || single.windows.some((window) => window.kind === "seven_day_model" && window.model))}
		<UsageForecast account={single} {now} framed />
		<div class="flex flex-col gap-[11px]">
			{@render windowRow(single, "five_hour", "Current 5-hour window", true)}
			{@render windowRow(single, "seven_day", "This week · all models", true)}
			{#each single.windows as window, index (index)}
				{#if window.kind === "seven_day_model" && window.model}
					<div data-testid="usage-settings-single-model-row" class="min-w-0">{@render meter(single, window, `This week · ${window.model}`, "usage-settings-model", true)}</div>
				{/if}
			{/each}
		</div>
	{:else}
		<p class="text-[12px] leading-[1.5] text-text-dimmer">No plan limits for this login. Conduit reads them from a Claude subscription sign-in; API keys, Bedrock, Vertex and proxy routes don't report them.</p>
	{/if}
	<div class="mt-[6px] flex min-h-[30px] items-center gap-[8px] border-t border-border pt-[10px]">
		<span class="flex-1 text-[12px] text-text">Warn me at</span>
		<SegmentedControl
			variant="joined"
			label="Warn me at"
			options={warnOptions.map((warnAt) => ({ value: String(warnAt), label: warnAt === "off" ? "off" : phone.current ? String(warnAt) : `${warnAt}%`, testId: `usage-settings-warn-${warnAt}`, disabled: setting === null }))}
			bind:value={() => String(setting?.warnAt ?? 80), (next) => {
				const warnAt = warnOptions.find((option) => String(option) === next);
				if (setting && warnAt !== undefined) void save({ ...setting, warnAt });
			}}
		/>
	</div>
	<UsageLimitsSettings {setting} {several} onsave={save} />
</section>
