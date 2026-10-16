<!-- The limit strip above the composer while a session's account is at its usage
     limit. A pure render of the session row's `limitRecovery` plus its recovery
     actions: no close button, it leaves when the server nulls the field. Once a
     resume at reset is scheduled it turns amber and counts down to it. The
     actions sit at the right of the row, on a wrapped second row on phones.
     With another Claude account to go to, Switch account leads both states. -->
<script lang="ts">
	import { toastFailure } from "../../transport/rpc-errors.js";
	import type { LimitRecovery } from "../../../contracts/limit-recovery.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { getClaudeAccounts } from "../../stores/claude-accounts.svelte.js";
	import { findSession } from "../../stores/session.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { formatSnoozeTime } from "../../utils/format.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Surface from "../ui/Surface.svelte";
	import AccountSwitch from "./AccountSwitch.svelte";

	let {
		limitRecovery,
		sessionId,
		projectSlug,
	}: { limitRecovery: LimitRecovery; sessionId: string; projectSlug: string } = $props();

	let busy = $state(false);
	const claudeAccounts = $derived(getClaudeAccounts(projectSlug));
	const accountId = $derived(findSession(sessionId)?.accountId ?? undefined);

	const account = $derived(
		accountId ? claudeAccounts.nameOf(accountId, accountId) : "Account unavailable",
	);
	// Switch account needs another Claude account to go to.
	const canSwitch = $derived(
		accountId !== undefined && claudeAccounts.hasAlternative(accountId),
	);
	const geometry = $derived(
		sessionViewState.compact ? "h-[34px] flex-1 rounded-[10px] text-[12px]" : "h-[24px] rounded-[8px] text-[11px]",
	);
	const limitWindow = $derived(
		limitRecovery.rateLimitType.startsWith("seven_day")
			? "Weekly limit"
			: limitRecovery.rateLimitType === "five_hour"
				? "5-hour limit"
				: "Usage limit",
	);
	const scheduledAt = $derived(limitRecovery.continued ? undefined : limitRecovery.scheduledAt);
	const resumesAt = $derived(scheduledAt === undefined ? "" : formatSnoozeTime(scheduledAt * 1000));
	// Worked out on read from the local clock, so it ticks without the server.
	const countdown = $derived.by(() => {
		if (scheduledAt === undefined) return "";
		const seconds = Math.ceil(scheduledAt - clock.now / 1000);
		if (seconds <= 0) return "due now";
		const [days, hours, minutes] = [Math.floor(seconds / 86_400), Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60];
		if (days > 0) return `in ${days}d ${hours}h`;
		if (hours > 0) return `in ${hours}h ${minutes}m`;
		return minutes > 0 ? `in ${minutes}m` : `in ${seconds}s`;
	});
	const detail = $derived.by(() => {
		if (limitRecovery.resetsAt === undefined)
			return sessionViewState.compact ? `${account} · reset time unavailable` : "Reset time unavailable";
		const resets = `resets ${formatSnoozeTime(limitRecovery.resetsAt * 1000)}`;
		return `${sessionViewState.compact ? account : limitWindow} · ${resets}`;
	});

	// Each action is one RPC on the session's own account. A refusal leaves the
	// strip as it is and shows its message; success waits for the server's
	// projection to change the strip.
	async function run(call: Promise<unknown>, failure: string): Promise<void> {
		busy = true;
		try {
			await call;
		} catch (error) {
			toastFailure(failure)(error);
		} finally {
			busy = false;
		}
	}

	// Without `at` the server re-checks quota and continues now; with it, the
	// server schedules the resume and the strip turns to its waiting state.
	async function continueAt(at?: number): Promise<void> {
		const currentAccountId = accountId;
		if (!currentAccountId) {
			showToast("No account is available for this session. Add a Claude account in Settings before continuing.", { variant: "error" });
			return;
		}
		return run(
			rpc("ContinueSession", {
				projectSlug,
				sessionId,
				instanceId: currentAccountId,
				expectedInstanceId: currentAccountId,
				...(at === undefined ? {} : { at }),
				originId: getBrowserClientId(),
			}),
			"Couldn't continue the session",
		);
	}

	const cancelResume = () =>
		run(rpc("CancelContinuation", { projectSlug, sessionId, originId: getBrowserClientId() }), "Couldn't cancel the resume");
</script>

<!-- The strip's main action while limited, second to a scheduled resume. -->
{#snippet switchAccount(primary: boolean, currentAccountId: string)}
	<AccountSwitch {sessionId} {projectSlug} account={currentAccountId} limit={limitRecovery} side="top">
		{#snippet trigger({ props, loading })}
			<Button
				{...props}
				variant={primary ? "inverse" : "secondary"}
				size="content"
				iconSize={12}
				{loading}
				data-testid="usage-limit-switch-account"
				class="gap-[5px] px-[10px] {primary ? 'font-semibold' : ''} {sessionViewState.compact ? 'justify-center' : ''} {geometry}"
			>
				Switch account{#if !sessionViewState.compact}<Icon name="chevron-down" size={12} />{/if}
			</Button>
		{/snippet}
	</AccountSwitch>
{/snippet}

<Surface
	variant={scheduledAt === undefined ? "danger" : "warning"}
	radius="none"
	data-testid="usage-limit-strip"
	data-state={scheduledAt === undefined ? "limited" : "waiting"}
	class="mb-2 flex flex-wrap items-center gap-[7px] rounded-2xl px-[10px] py-[7px] text-[11.5px] leading-[1.35]"
>
	{#if scheduledAt === undefined}
		<Icon name="gauge" size={13} class="shrink-0 text-error" />
		<span class="min-w-0 flex-1">
			<b data-testid="usage-limit-title" class="font-semibold text-text">Usage limit reached{sessionViewState.compact ? "" : ` · ${account}`}</b><br />
			<span data-testid="usage-limit-detail" class="text-text-dimmer">{detail}</span>
		</span>
		{#if !limitRecovery.continued}
			<div class="flex gap-[6px] {sessionViewState.compact ? 'mt-[6px] w-full' : 'shrink-0'}">
				{#if canSwitch && accountId}
					{@render switchAccount(true, accountId)}
				{/if}
				{#if limitRecovery.resetsAt === undefined}
					<Button variant={canSwitch ? "secondary" : "inverse"} size="content" iconSize={12} loading={busy} disabled={busy} data-testid="usage-limit-try-again" class="px-[10px] {canSwitch ? '' : 'font-semibold'} {geometry}" onclick={() => continueAt()}>Try again</Button>
				{:else}
					<Button variant="secondary" size="content" iconSize={12} loading={busy} disabled={busy} data-testid="usage-limit-resume-at-reset" class="px-[10px] {geometry}" onclick={() => continueAt(limitRecovery.resetsAt)}>Resume at reset</Button>
				{/if}
			</div>
		{/if}
	{:else}
		<Icon name="timer" size={13} class="shrink-0 text-warning" />
		<span class="min-w-0 flex-1">
			<b data-testid="usage-limit-title" class="font-semibold text-text">{sessionViewState.compact ? `Resumes ${resumesAt}` : `Resumes on ${account} at ${resumesAt}`}</b><br />
			<span data-testid="usage-limit-detail" class="text-text-dimmer">{sessionViewState.compact ? `${account} · ${countdown}` : countdown}{limitRecovery.auto ? " · auto-resume is on" : ""}</span>
		</span>
		<div class="flex gap-[6px] {sessionViewState.compact ? 'mt-[6px] w-full' : 'shrink-0'}">
			{#if canSwitch && accountId}
				{@render switchAccount(false, accountId)}
			{/if}
			<Button variant="ghost" size="content" iconSize={12} loading={busy} disabled={busy} data-testid="usage-limit-cancel-resume" class="text-[11px] {sessionViewState.compact ? 'h-[34px] flex-1 rounded-[10px] px-[8px]' : 'h-[24px] rounded-[8px] px-[10px]'}" onclick={cancelResume}>Cancel auto-resume</Button>
		</div>
	{/if}
</Surface>
