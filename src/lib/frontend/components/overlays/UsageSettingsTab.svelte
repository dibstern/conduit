<script module lang="ts">
	import type { UsageLimitsSetting } from "../../../contracts/limit-recovery.js";
	import { rpc } from "../../transport/ws-rpc-client.js";

	// Saves stay ordered across Settings tab mounts, and loads wait for their flush.
	let usageLimitsSaves: Promise<void> = Promise.resolve();

	async function getUsageLimitsSettingRpc(): Promise<UsageLimitsSetting> {
		await usageLimitsSaves;
		const result = await rpc("GetUsageLimitsSetting", {});
		return result.usageLimits;
	}

	async function setUsageLimitsSettingRpc(usageLimits: UsageLimitsSetting): Promise<UsageLimitsSetting> {
		const request = usageLimitsSaves.then(() => rpc("SetUsageLimitsSetting", { usageLimits }));
		usageLimitsSaves = request.then(() => undefined, () => undefined);
		const result = await request;
		return result.usageLimits;
	}
</script>

<script lang="ts">
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import type { UsageReading, UsageWindow } from "../../../contracts/limit-recovery.js";
	import { getClaudeAccounts } from "../../stores/claude-accounts.svelte.js";
	import { getEffectiveInstanceId } from "../../stores/discovery.svelte.js";
	import { getCachedInstances, getDriverTraits } from "../../stores/instance.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { findSession } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { applyUsageLimitsSetting, orderedSettingsUsageAccounts, usageAlert, usageState } from "../../stores/usage.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { usageDisplay, usageForecastDuration, usageForecastTime, usageForecastWindow, usagePaceLine, usageResetTime } from "../../utils/continuation.js";
	import AccountDot from "../ui/AccountDot.svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import SortableList from "../ui/SortableList.svelte";
	import SettingsBanner from "../ui/SettingsBanner.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import UsageForecast from "./UsageForecast.svelte";
	import UsageLimitsSettings from "./UsageLimitsSettings.svelte";

	const project = $derived(projectState.projects.find((item) => item.slug === getCurrentSlug()));
	const refreshSlug = $derived(project?.slug ?? projectState.projects[0]?.slug);
	const claudeAccounts = $derived(getClaudeAccounts(refreshSlug ?? ""));
	const accounts = $derived(orderedSettingsUsageAccounts().filter((account) => account.harness === "claude"));
	const cursorAccounts = $derived(getCachedInstances().filter((account) => getDriverTraits(account.driver)?.usageHarness === "cursor"));
	const several = $derived(accounts.length > 1);
	const single = $derived(accounts[0]);
	const sessionId = $derived(getCurrentSessionId());
	const sessionAccountId = $derived(sessionId ? findSession(sessionId)?.accountId : undefined);
	const currentAccountId = $derived(sessionAccountId ?? getEffectiveInstanceId());
	const forecastAccount = $derived(sessionId
		? accounts.find((account) => account.accountId === sessionAccountId)
		: accounts.find((account) => account.accountId === getEffectiveInstanceId()) ?? accounts.reduce<UsageReading | undefined>((fullest, account) =>
			!fullest || (usageDisplay(account, "off").binding?.utilization ?? -1) > (usageDisplay(fullest, "off").binding?.utilization ?? -1) ? account : fullest, undefined));
	let expandedAccounts = $state<string[]>([]);
	/** Phone only: whether the account order shows its drag handles. */
	let reordering = $state(false);
	let setting = $state<UsageLimitsSetting | null>(null);
	let confirmed: UsageLimitsSetting | null = null;
	let saveTicket = 0;
	let refreshing = $state(false);
	let keychainPending = $state<string | null>(null);
	let keychainErrors = $state<Record<string, string | undefined>>({});
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
			.catch((error) => {
				if (current) toastFailure("Couldn't load usage limit settings")(error);
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
		} catch (error) {
			if (ticket === saveTicket) setting = confirmed;
			toastFailure("Couldn't save usage limit settings")(error);
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

	async function setCursorKeychain(accountId: string, enabled: boolean): Promise<void> {
		if (keychainPending) return;
		keychainPending = accountId;
		keychainErrors[accountId] = undefined;
		try {
			const result = await rpc("SetCursorUsageKeychain", { accountId, enabled });
			if (result.reason) keychainErrors[accountId] = result.reason;
			else if (enabled) await refresh();
		} catch {
			keychainErrors[accountId] = "Couldn't update Keychain usage. Try again.";
		} finally {
			keychainPending = null;
		}
	}

	function hasPlanData(account: UsageReading | undefined): boolean {
		return account !== undefined && account.status !== "unknown" && account.status !== "unavailable" &&
			account.windows.some((window) => window.kind === "five_hour" || window.kind === "seven_day");
	}

	/** `full` reads as a sentence; otherwise it fits a 62px meter column under its heading. */
	function resetLine(window: UsageWindow | undefined, full: boolean): string {
		if (!window || (window.kind === "five_hour" && window.utilization === 0 && !window.resetsAt)) return full ? "no window open" : "not open";
		const time = usageResetTime(window.resetsAt, window.kind === "seven_day");
		if (!time) return window.utilization >= 100 ? (full ? "limit reached" : "limited") : full ? "reset time unavailable" : "—";
		if (window.kind === "seven_day") return full ? `resets ${time}` : time;
		if (window.utilization >= 100) return full ? `limit reached · resets ${time}` : time;
		const minutes = Math.max(0, Math.ceil((Date.parse(window.resetsAt ?? "") - now) / 60_000));
		const remaining = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
		return full ? `resets in ${remaining} (${time})` : `in ${remaining}`;
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
			const time = usageResetTime(limitWindow(account)?.resetsAt);
			return time ? `Limited until ${time}` : "Limited";
		}
		return display.level === "warn" && display.binding
			? `${Math.round(display.binding.utilization)}% of ${display.binding.kind === "seven_day" ? "weekly" : "5-hour"} window`
			: account.accountId === currentAccountId ? "Current" : "Available";
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
	{@const value = window ? display.level === "limited" ? usageResetTime(window.resetsAt, window.kind === "seven_day") || `${Math.round(window.utilization)}%` : `${Math.round(window.utilization)}%` : "—"}
	{@const valueTone = display.level === "limited" ? "text-error" : display.level === "warn" ? "text-fill-amber" : "text-text-secondary"}
	{#if full}
		<div class="mb-[3px] flex items-baseline gap-[6px] text-[11px]">
			<span data-testid="{prefix}-label" class="flex-1">{label}</span>
			<span data-testid="{prefix}-value" class="font-mono text-[10.5px] {valueTone}">{value}</span>
		</div>
	{/if}
	<div data-testid="{prefix}-bar" data-level={display.level} class="w-full overflow-hidden rounded-full bg-border-chip {full ? 'h-[6px]' : 'h-[5px]'}" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window?.utilization} aria-valuetext={window ? `${Math.round(window.utilization)}% used` : "no window open"}>
		<div class="h-full {display.colour}" style:width="{window?.utilization ?? 0}%"></div>
	</div>
	{#if !full}<div data-testid="{prefix}-value" class="mt-[4px] font-mono text-[11px] leading-[14px] {valueTone}">{value}</div>{/if}
{/snippet}

{#snippet windowRow(account: UsageReading, kind: "five_hour" | "seven_day", label: string, full: boolean)}
	{@const window = account.windows.find((item) => item.kind === kind)}
	{@const prefix = full ? `usage-settings-single-${kind}` : `usage-settings-card-${account.accountId}-${kind}`}
	<div class={full ? "min-w-0" : "w-[70px] shrink-0 self-start pt-[6px] max-md:w-[62px]"}>
		{@render meter(account, window, label, prefix, full)}
		{#if full || !window || window.utilization < 100 || !usageResetTime(window.resetsAt)}
			<div data-testid="{prefix}-reset" class="text-text-dimmer {full ? 'mt-[3px] font-mono text-[10.5px]' : 'truncate text-[10.5px] leading-[13px]'}">{resetLine(window, full)}</div>
		{/if}
	</div>
{/snippet}

{#snippet subheader()}
	<div data-testid="usage-settings-subheader" class="text-[12px] text-text-dimmer {several ? 'md:ml-auto' : 'text-right'}">
		{#if !several && !hasPlanData(single)}Claude{:else}
		<span>{several ? `${accounts.length} accounts` : single?.planLabel ?? claudeAccounts.nameOf(undefined)} · updated {updatedLabel} · </span>
		<TextButton class="max-md:min-h-[44px] max-md:min-w-[44px]" tone="dimmer" underline="always" data-testid="usage-settings-refresh" disabled={refreshing || !refreshSlug} aria-busy={refreshing} onclick={refresh}>{several ? "Refresh all" : "Refresh"}</TextButton>
		{/if}
	</div>
{/snippet}

<section id="usage-settings" data-testid="usage-settings" class="min-w-0" aria-label="Claude plan usage">
	{#if several}
		<SettingsBanner id="usage-settings-headline" data-testid="usage-settings-headline" class="mb-[14px]" tone={headline.limited ? "danger" : headline.warning ? "warning" : "neutral"}>{#if headline.bold}<b>{headline.bold}</b>{headline.text.slice(headline.bold.length)}{:else}{headline.text}{/if}</SettingsBanner>
	{/if}
	<SettingsGroup title="Claude plan usage">
		{#snippet actions()}
			{#if several}
				<div aria-hidden="true" class="flex gap-[10px] pr-[10px] text-[12px] font-medium text-text-dimmer max-md:text-[13px]">
					<span class="w-[70px] max-md:w-[62px]">5-hour</span><span class="w-[70px] max-md:w-[62px]">Week</span>
				</div>
			{:else}
				{@render subheader()}
			{/if}
		{/snippet}
	{#if several}
		<SortableList items={accounts} key={(account) => account.accountId} label={nameOf} ariaLabel="Auto-switch account order" variant="settings" disabled={setting === null} handles={!sessionViewState.compact || reordering} onreorder={(next) => {
			if (setting) void save({ ...setting, order: next.map((account) => account.accountId) });
		}}>
			{#snippet row(account, index)}
				{@const level = usageDisplay(account, usageState.limits.warnAt).level}
				{#if !sessionViewState.compact}<span data-testid="usage-settings-position-{account.accountId}" class="w-[14px] shrink-0 text-center font-mono text-[11px] text-text-dimmer">{index + 1}</span>{/if}
				<div class="min-w-0 flex-1">
					<div class="flex min-w-0 items-center gap-[7px]">
						<AccountDot instanceId={account.accountId} size={7} data-testid="usage-settings-dot-{account.accountId}" />
						<span data-testid="usage-limit-account-name" class="min-w-0 truncate font-medium text-text">{nameOf(account)}</span>
						{#if hasPlanData(account) && account.planLabel}<Badge variant="tag" size="xs" class="shrink-0 font-mono" data-testid="usage-settings-plan-{account.accountId}">{account.planLabel}</Badge>{/if}
					</div>
					<div data-testid="usage-settings-status-{account.accountId}" class="mt-[2px] truncate text-[12px] {level === 'limited' ? 'text-error' : level === 'warn' ? 'text-fill-amber' : hasPlanData(account) && account.accountId === currentAccountId ? 'text-success' : 'text-text-dimmer'}">{statusOf(account)}</div>
				</div>
				{#if hasPlanData(account)}
					{@render windowRow(account, "five_hour", "5h", false)}
					{@render windowRow(account, "seven_day", "Week", false)}
				{/if}
			{/snippet}
			{#snippet details(account)}
				{@const models = account.windows.flatMap((window) => window.kind === "seven_day_model" && window.model
					? [`${window.model} week ${Math.round(window.utilization)}%`] : [])}
				<!-- Desktop details line up under the name, past the handle and position. -->
				<div id="usage-settings-card-{account.accountId}" data-testid="usage-settings-card-{account.accountId}" class="md:pl-[48px]">
					{#if !hasPlanData(account)}<p class="mt-[6px] font-mono text-[10.5px] text-text-dimmer">No plan data for this login (API key, Bedrock, Vertex or proxy). Auto-switch can still pick it.</p>{/if}
					{#if models.length > 0}<div data-testid="usage-settings-models-{account.accountId}" class="mt-[7px] font-mono text-[10.5px] text-text-dimmer">{models.join(" · ")}</div>{/if}
					{#if usageForecastWindow(account)}
						{@const pace = usagePaceLine(account, now)}
						{#if account === forecastAccount || !pace}
							<UsageForecast {account} {now} />
						{:else}
								<Button touchTarget variant="ghost" size="content" layout="flow" tone="muted" hoverFill="none" data-testid="usage-settings-pace-{account.accountId}" aria-expanded={expandedAccounts.includes(account.accountId)} aria-controls="usage-settings-forecast-{account.accountId}" class="mt-[6px] flex w-full items-start gap-[8px] text-left font-mono text-[10.5px]" onclick={() => {
									expandedAccounts = expandedAccounts.includes(account.accountId) ? expandedAccounts.filter((id) => id !== account.accountId) : [...expandedAccounts, account.accountId];
								}}><span class="min-w-0 flex-1">{pace}</span><span aria-hidden="true" class="text-text-dimmer">›</span></Button>
							{#if expandedAccounts.includes(account.accountId)}<UsageForecast {account} {now} />{/if}
						{/if}
					{/if}
				</div>
			{/snippet}
		</SortableList>
	{:else if single && (hasPlanData(single) || single.windows.some((window) => window.kind === "seven_day_model" && window.model))}
		<UsageForecast account={single} {now} framed />
		<div class="flex flex-col gap-[11px] px-[14px] py-[10px]">
			{@render windowRow(single, "five_hour", "Current 5-hour window", true)}
			{@render windowRow(single, "seven_day", "This week · all models", true)}
			{#each single.windows as window, index (index)}
				{#if window.kind === "seven_day_model" && window.model}
					<div data-testid="usage-settings-single-model-row" class="min-w-0">{@render meter(single, window, `This week · ${window.model}`, "usage-settings-model", true)}</div>
				{/if}
			{/each}
		</div>
	{:else}
		<p class="px-[14px] py-[10px] text-[12px] leading-[1.5] text-text-dimmer">No plan limits for this login. Conduit reads them from a Claude subscription sign-in; API keys, Bedrock, Vertex and proxy routes don't report them.</p>
	{/if}
	</SettingsGroup>
	{#if several}
		<div class="mx-[4px] mt-[8px] flex flex-wrap items-center gap-x-[12px] gap-y-[2px] text-[12px] text-text-dimmer">
			<!-- Phones hide the handles until asked, as the Final drawing shows them without grips. -->
			{#if !sessionViewState.compact || reordering}<p data-testid="usage-settings-order-hint" class="max-md:basis-full">Drag ⠿ to set the auto-switch order.</p>{/if}
			{@render subheader()}
			{#if sessionViewState.compact}
				<TextButton class="min-h-[44px] min-w-[44px]" tone="dimmer" underline="always" data-testid="usage-settings-reorder" aria-pressed={reordering} disabled={setting === null} onclick={() => { reordering = !reordering; }}>{reordering ? "Done" : "Edit order"}</TextButton>
			{/if}
		</div>
	{/if}
	<UsageLimitsSettings {setting} {several} onsave={save} />
</section>

{#if cursorAccounts.length > 0}
	<SettingsGroup id="cursor-usage-settings" testId="cursor-usage-settings" title="Cursor plan usage">
		{#snippet actions()}
			<TextButton class="max-md:min-h-[44px] max-md:min-w-[44px]" tone="dimmer" underline="always" data-testid="cursor-usage-refresh" disabled={refreshing || !refreshSlug} aria-busy={refreshing} onclick={refresh}>Refresh</TextButton>
		{/snippet}
			{#each cursorAccounts as account (account.id)}
				{@const reading = account.usageEligible ? usageState.readings.find((item) => item.accountId === account.id) : undefined}
				{@const month = reading && (reading.status === "available" || reading.status === "limited") ? reading.windows.find((window) => window.kind === "month") : undefined}
				<div data-testid="cursor-usage-card-{account.id}" class="px-[14px] py-[10px]">
					<div class="mb-[8px] flex items-center gap-[6px] text-[13.5px] max-md:text-[15px]">
						<AccountDot instanceId={account.id} size={7} />
						<span class="min-w-0 flex-1 truncate font-semibold text-text">{account.name}</span>
						{#if account.cursorUsageSource === "keychain"}
							<TextButton class="max-md:min-h-[44px] max-md:min-w-[44px]" tone="dimmer" underline="always" data-testid="cursor-usage-disable-{account.id}" disabled={keychainPending !== null} aria-busy={keychainPending === account.id} onclick={() => void setCursorKeychain(account.id, false)}>Disable</TextButton>
						{/if}
					</div>
					{#if reading && month}
						{@render meter(reading, month, "Month", `cursor-usage-${account.id}-month`, false)}
						{#if month.resetsAt && Number.isFinite(Date.parse(month.resetsAt))}
							<div data-testid="cursor-usage-{account.id}-reset" class="mt-[3px] font-mono text-[10.5px] text-text-dimmer">Resets {new Date(month.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</div>
						{/if}
					{:else}
						<p data-testid="cursor-usage-reason-{account.id}" class="text-[11px] leading-[1.5] text-text-dimmer">{reading?.reason ?? (account.cursorUsageSource === "unsupported" ? "Set CURSOR_AUTH_TOKEN in Accounts to read usage on this computer." : account.cursorUsageSource === "can_enable" ? "Usage isn't enabled." : "Usage hasn't been read yet.")}</p>
					{/if}
					{#if account.cursorUsageSource === "can_enable"}
						<p class="mt-[7px] text-[11px] leading-[1.5] text-text-dimmer">Reads the Cursor CLI login from this Mac's Keychain. macOS asks first; "Always Allow" stops future prompts. Or set CURSOR_AUTH_TOKEN in Accounts.</p>
						<Button touchTarget variant="secondary" size="sm" data-testid="cursor-usage-enable-{account.id}" class="mt-[8px]" disabled={keychainPending !== null} onclick={() => void setCursorKeychain(account.id, true)}>{keychainPending === account.id ? "Enabling..." : "Enable"}</Button>
					{/if}
					{#if keychainErrors[account.id]}<p role="status" data-testid="cursor-usage-error-{account.id}" class="mt-[7px] text-[11px] leading-[1.5] text-error">{keychainErrors[account.id]}</p>{/if}
				</div>
			{/each}
	</SettingsGroup>
{/if}
