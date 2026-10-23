<!-- Warn before the composer's account reaches its plan limit. Dismissals
     stay in memory per session or draft project until 95% or a new window. -->
<script module lang="ts">
	import { SvelteMap } from "svelte/reactivity";

	const dismissals = new SvelteMap<string, {
		kind: "five_hour" | "seven_day";
		resetsAt?: string;
		below95: boolean;
	}>();
</script>

<script lang="ts">
	import { accountLimit } from "../../../contracts/account-limit.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { getClaudeAccounts } from "../../stores/claude-accounts.svelte.js";
	import { getDriverTraits, getInstanceById } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { composerAccountId, usageState } from "../../stores/usage.svelte.js";
	import type { Immutable, SessionInfo } from "../../types.js";
	import { usageForecastTime, usageWarning } from "../../utils/continuation.js";
	import { openSettings } from "../layout/chrome-actions.js";
	import Button from "../ui/Button.svelte";
	import ComposerStrip from "../ui/ComposerStrip.svelte";
	import Icon from "../ui/Icon.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import AccountSwitch from "./AccountSwitch.svelte";

	let { session, projectSlug }: { session: Immutable<SessionInfo> | undefined; projectSlug: string } = $props();

	const key = $derived(session?.id ?? projectSlug);
	const accountId = $derived(composerAccountId(session));
	const claudeAccounts = $derived(getClaudeAccounts(projectSlug, getDriverTraits(getInstanceById(accountId ?? "")?.driver)?.usageHarness === "codex" ? "codex" : "claude"));
	const reading = $derived(claudeAccounts.readingOf(accountId));
	const severalAccounts = $derived(claudeAccounts.hasAlternative(accountId));
	const alternatives = $derived(claudeAccounts.configuredAccounts.filter((account) => {
		const reading = claudeAccounts.quotaOf(account.id) ?? claudeAccounts.readingOf(account.id);
		return account.id !== accountId && accountLimit({
			asker: "user",
			modelId: session?.model?.model,
			...(reading ? { reading } : {}),
			now: clock.now,
		}).kind === "go";
	}));
	const compactSwitchLabel = $derived(alternatives.length === 1 ? `Switch to ${alternatives[0]?.name}` : "Switch account");
	const warning = $derived(usageWarning(reading, usageState.limits.warnAt, claudeAccounts.nameOf(accountId), severalAccounts, clock.now));
	const limited = $derived(session?.limitRecovery && !session.limitRecovery.switched);
	const resetsAt = $derived(usageForecastTime(warning?.window.resetsAt, clock.now));

	// Claude's resets_at jitters between reads; only a jump of more than ten
	// minutes is a new window.
	const newWindow = (before: string | undefined, after: string | undefined) =>
		before !== after && (before === undefined || after === undefined || Math.abs(Date.parse(after) - Date.parse(before)) > 10 * 60_000);

	// Clear a dismissal once, so dropping below 95% cannot hide a rearmed warning.
	$effect(() => {
		const dismissed = dismissals.get(key);
		if (!dismissed || !reading) return;
		const window = reading.windows.find((window) => window.kind === dismissed.kind);
		if (
			(window && (newWindow(dismissed.resetsAt, window.resetsAt) || (dismissed.below95 && window.utilization >= 95))) ||
			(dismissed.kind === "five_hour" && warning?.window.kind === "seven_day")
		) dismissals.delete(key);
	});
	function dismissWarning() {
		if (warning) dismissals.set(key, {
			kind: warning.window.kind,
			...(warning.window.resetsAt === undefined ? {} : { resetsAt: warning.window.resetsAt }),
			below95: warning.window.utilization < 95,
		});
	}
</script>

{#snippet dismiss()}
	<Button variant="ghost" size="composer-icon" tone="muted" iconOnly icon="x" iconSize={12} touchTarget ariaLabel="Dismiss usage warning" data-testid="usage-warning-dismiss" class="shrink-0" onclick={dismissWarning} />
{/snippet}

{#if warning && !limited && !dismissals.has(key)}
	<ComposerStrip tone="ask" data-testid="usage-warning-strip" data-window={warning.window.kind} class="flex flex-wrap items-center gap-[8px]">
		<Icon name="gauge" size={15} class="shrink-0 text-status-ask" />
		<span class="flex-1 min-w-0">
			<span data-testid="usage-warning-title">This session's account, <b class="font-semibold text-text">{claudeAccounts.nameOf(accountId)}</b>, has used {Math.round(warning.window.utilization)}% of its {warning.window.kind === "seven_day" ? "weekly" : "5-hour"} window.</span>
			{#if resetsAt}<span data-testid="usage-warning-detail" class="block text-[12px] text-text-muted">Resets at {resetsAt}</span>{/if}
		</span>
		{#if severalAccounts && session && accountId}
			<div class="flex gap-[6px] {sessionViewState.compact ? 'mt-[2px] w-full' : 'shrink-0'}">
				<AccountSwitch sessionId={session.id} {projectSlug} account={accountId} limit={undefined} side="top">
					{#snippet trigger({ props, loading })}
						<Button {...props} variant="ask" size="composer-chip" iconSize={12} {loading} touchTarget data-testid="usage-warning-switch-account" class={sessionViewState.compact ? 'flex-1 justify-center' : ''}>
							{#if sessionViewState.compact}{compactSwitchLabel}{:else}Switch account<Icon name="chevron-down" size={12} />{/if}
						</Button>
					{/snippet}
				</AccountSwitch>
				{#if sessionViewState.compact}<Button variant="secondary" size="composer-chip" touchTarget ariaLabel="Dismiss usage warning" data-testid="usage-warning-dismiss" class="flex-1" onclick={dismissWarning}>Dismiss</Button>{/if}
			</div>
		{:else if sessionViewState.compact}
			<div class="mt-[2px] flex w-full justify-end"><Button variant="secondary" size="composer-chip" touchTarget ariaLabel="Dismiss usage warning" data-testid="usage-warning-dismiss" onclick={dismissWarning}>Dismiss</Button></div>
		{:else if !severalAccounts}
			<TextButton tone="inherit" data-testid="usage-warning-details" class="shrink-0 font-semibold text-status-ask" onclick={() => openSettings("usage")}>Details</TextButton>
		{/if}
		{#if !sessionViewState.compact}{@render dismiss()}{/if}
	</ComposerStrip>
{/if}
