<!-- The limit strip above the composer while a session's account is at its usage
     limit. A pure render of the session row's `limitRecovery` plus its recovery
     actions: no close button, it leaves when the server nulls the field. Once a
     resume at reset is scheduled it turns amber and counts down to it. The
     actions sit at the right of the row, on a wrapped second row on phones.
     With another Claude account to go to, Switch account leads both states. -->
<script lang="ts">
	import type { LimitRecovery } from "../../../contracts/limit-recovery.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { getInstanceById, instanceState } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { cancelContinuationRpc, continueSessionRpc } from "../../transport/ws-rpc-client.js";
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

	const account = $derived(
		getInstanceById(limitRecovery.instanceId)?.name ?? limitRecovery.instanceId,
	);
	// Switch account needs another Claude account to go to.
	const canSwitch = $derived(
		instanceState.instances.some((instance) => instance.driver === "claude" && instance.id !== limitRecovery.instanceId),
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
	async function run(call: Promise<void>, failure: string): Promise<void> {
		busy = true;
		try {
			await call;
		} catch (error) {
			showToast(error instanceof Error && error.message ? error.message : failure, { variant: "error" });
		} finally {
			busy = false;
		}
	}

	// Without `at` the server re-checks quota and continues now; with it, the
	// server schedules the resume and the strip turns to its waiting state.
	const continueAt = (at?: number) =>
		run(
			continueSessionRpc({
				projectSlug,
				sessionId,
				instanceId: limitRecovery.instanceId,
				expectedInstanceId: limitRecovery.instanceId,
				...(at === undefined ? {} : { at }),
				originId: getBrowserClientId(),
			}),
			"Couldn't continue the session",
		);

	const cancelResume = () =>
		run(cancelContinuationRpc({ projectSlug, sessionId, originId: getBrowserClientId() }), "Couldn't cancel the resume");
</script>

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
				{#if canSwitch}
					<AccountSwitch {limitRecovery} {sessionId} {projectSlug} primary class="px-[10px] {geometry}" />
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
			{#if canSwitch}
				<AccountSwitch {limitRecovery} {sessionId} {projectSlug} primary={false} class="px-[10px] {geometry}" />
			{/if}
			<Button variant="ghost" size="content" iconSize={12} loading={busy} disabled={busy} data-testid="usage-limit-cancel-resume" class="text-[11px] {sessionViewState.compact ? 'h-[34px] flex-1 rounded-[10px] px-[8px]' : 'h-[24px] rounded-[8px] px-[10px]'}" onclick={cancelResume}>Cancel auto-resume</Button>
		</div>
	{/if}
</Surface>
