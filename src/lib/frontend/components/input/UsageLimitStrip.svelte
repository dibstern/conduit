<!-- Limit Recovery stays visible until a reply clears it or the session switches
     accounts. The reset action refreshes the account's Usage Reading on the server. -->
<script lang="ts">
	import { accountLimit, accountLimitWindowLabel } from "../../../contracts/account-limit.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import type { LimitRecovery } from "../../../contracts/limit-recovery.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { getClaudeAccounts } from "../../stores/claude-accounts.svelte.js";
	import { getDriverTraits, getInstanceById } from "../../stores/instance.svelte.js";
	import { findSession } from "../../stores/session.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { usageState } from "../../stores/usage.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { usageForecastTime } from "../../utils/continuation.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import ComposerStrip from "../ui/ComposerStrip.svelte";
	import AccountSwitch from "./AccountSwitch.svelte";

	let {
		limitRecovery,
		sessionId,
		projectSlug,
		presentation = "strip",
	}: { limitRecovery: LimitRecovery; sessionId: string; projectSlug: string; presentation?: "strip" | "tray" } = $props();

	let busy = $state(false);
	const accountId = $derived(findSession(sessionId)?.accountId ?? undefined);
	const claudeAccounts = $derived(getClaudeAccounts(projectSlug, getDriverTraits(getInstanceById(accountId ?? "")?.driver)?.usageHarness === "codex" ? "codex" : "claude"));

	const account = $derived(
		accountId ? claudeAccounts.nameOf(accountId, accountId) : "Account unavailable",
	);
	// Switch account needs another account of the same provider.
	const canSwitch = $derived(
		accountId !== undefined && claudeAccounts.hasAlternative(accountId),
	);
	// On phones the buttons share a row, with the reset link below them.
	const stretch = $derived(sessionViewState.compact);
	const geometry = $derived(stretch ? "flex-1 justify-center" : "");
	const limitWindow = $derived(accountLimitWindowLabel(limitRecovery.rateLimitType));
	const reading = $derived(claudeAccounts.readingOf(accountId));
	const answer = $derived(accountLimit({
		asker: "automatic",
		modelId: findSession(sessionId)?.model?.model,
		...(reading === undefined ? {} : { reading }),
		recovery: limitRecovery,
		now: clock.now,
	}));
	const scheduledAt = $derived(limitRecovery.continued ? undefined : limitRecovery.scheduledAt);
	const resetAt = $derived(answer.kind === "wait-until" ? answer.until / 1000 : limitRecovery.resetsAt);
	const stripState = $derived(
		!usageState.limits.autoResume && answer.kind === "go" ? "looks_reset"
		: !limitRecovery.cutOffMessageId ? "held"
		: scheduledAt !== undefined ? "waiting"
		: resetAt !== undefined ? "can_resume_at_reset"
		: "limited",
	);
	const resumesAt = $derived(scheduledAt === undefined ? "" : usageForecastTime(scheduledAt * 1000, clock.now));
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
	const waitingDetail = $derived(`${sessionViewState.compact ? `${account} · ` : ""}${countdown}${limitRecovery.auto ? " · auto-resume is on" : ""}`);
	const detail = $derived.by(() => {
		if (resetAt === undefined)
			return "Reset time unavailable";
		return `Resets at ${usageForecastTime(resetAt * 1000, clock.now)}.`;
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

	// Without `at` the server refreshes Usage and continues now; with it, the
	// server schedules the resume and the strip turns to its waiting state.
	async function continueAt(at?: number): Promise<void> {
		const currentAccountId = accountId;
		if (!currentAccountId) {
			showToast("No account is available for this session. Add an account in Settings before continuing.", { variant: "error" });
			return;
		}
		return run(
			rpc("ContinueSession", {
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
		run(rpc("CancelContinuation", { sessionId, originId: getBrowserClientId() }), "Couldn't cancel the resume");
</script>

<!-- The strip's main action while limited, second to a scheduled resume. -->
{#snippet switchAccount(primary: boolean, currentAccountId: string)}
	<AccountSwitch {sessionId} {projectSlug} account={currentAccountId} limit={limitRecovery} side="top">
		{#snippet trigger({ props, loading })}
			<Button
				{...props}
				variant={primary ? "danger-soft" : "secondary"}
				size="composer-chip"
				touchTarget
				iconSize={12}
				{loading}
				data-testid="usage-limit-switch-account"
				class="{primary ? 'font-semibold' : ''} {geometry}"
			>
				Switch account{#if !sessionViewState.compact}<Icon name="chevron-down" size={12} />{/if}
			</Button>
		{/snippet}
	</AccountSwitch>
{/snippet}

<!-- The copy keeps a readable width; the actions wrap below it before it squeezes. -->
{#snippet recovery()}
	{#if stripState === "looks_reset"}
		<Icon name="gauge" size={13} class="shrink-0 text-warning" />
		<b data-testid="usage-limit-title" class="min-w-[min(100%,16em)] flex-1 font-semibold text-text">Limit looks reset · Continue now</b>
	{:else if stripState === "held"}
		<Icon name="timer" size={13} class="shrink-0 text-warning" />
		<span class="min-w-[min(100%,16em)] flex-1">
			<b data-testid="usage-limit-title" class="font-semibold text-text">Waiting for {account}'s limit to reset</b>
			{#if presentation === "strip"}
				<span data-testid="usage-limit-detail" class="text-text-dimmer"> {detail}</span>
			{:else if scheduledAt !== undefined}
				<br />
				<span data-testid="usage-limit-detail" class="text-text-dimmer">{waitingDetail}</span>
			{/if}
		</span>
	{:else if scheduledAt === undefined}
		<Icon name="gauge" size={13} class="shrink-0 text-error" />
		<span class="min-w-[min(100%,16em)] flex-1">
			<b data-testid="usage-limit-title" class="font-semibold text-text">{presentation === "tray" ? `Waiting for ${account}'s limit to reset` : `${account} hit its ${limitWindow}.`}</b>{" "}
			{#if presentation === "strip"}<span data-testid="usage-limit-detail" class="text-text-dimmer">{detail}</span>{/if}
		</span>
	{:else}
		<Icon name="timer" size={13} class="shrink-0 text-warning" />
		<span class="min-w-[min(100%,16em)] flex-1">
			<b data-testid="usage-limit-title" class="font-semibold text-text">{presentation === "tray" ? `Waiting for ${account}'s limit to reset` : sessionViewState.compact ? `Resumes ${resumesAt}` : `Resumes on ${account} at ${resumesAt}`}</b><br />
			<span data-testid="usage-limit-detail" class="text-text-dimmer">{waitingDetail}</span>
		</span>
	{/if}
	{#if !limitRecovery.continued}
		<div class="flex flex-wrap items-center gap-[6px] {stretch ? 'mt-[6px] w-full' : 'ml-auto'}">
			<div class={stretch ? "flex w-full flex-wrap gap-[6px]" : "contents"}>
				{#if canSwitch && accountId}
					{@render switchAccount(scheduledAt === undefined && stripState !== "looks_reset", accountId)}
				{/if}
				{#if scheduledAt !== undefined}
					<Button variant="ghost" size="composer-chip" touchTarget iconSize={12} loading={busy} disabled={busy} data-testid="usage-limit-cancel-resume" class={geometry} onclick={cancelResume}>Cancel auto-resume</Button>
				{:else if resetAt !== undefined && stripState !== "looks_reset"}
					<Button variant="secondary" size="composer-chip" touchTarget iconSize={12} loading={busy} disabled={busy} data-testid="usage-limit-resume-at-reset" class={geometry} onclick={() => continueAt(resetAt)}>Resume at reset</Button>
				{/if}
				<Button variant="secondary" size="composer-chip" touchTarget iconSize={12} loading={busy} disabled={busy} data-testid="usage-limit-used-reset" class={geometry} onclick={() => continueAt()}>I used a reset</Button>
			</div>
			<a href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer" data-testid="usage-limit-reset-link" class="text-[12px] text-text-muted underline underline-offset-2 hover:text-text">Use a reset on Claude ↗</a>
		</div>
	{/if}
{/snippet}

{#if presentation === "tray"}
	<div data-testid="pending-input-waiting" data-state={stripState} class="flex min-h-[30px] flex-wrap items-center gap-[8px] px-[6px] text-[12px] text-text-muted">
		{@render recovery()}
	</div>
{:else}
<ComposerStrip
	tone={stripState === "looks_reset" || stripState === "waiting" || stripState === "held" ? "ask" : "risk"}
	data-testid="usage-limit-strip"
	data-state={stripState}
	class="flex flex-wrap items-center gap-[8px]"
>
	{@render recovery()}
</ComposerStrip>
{/if}

