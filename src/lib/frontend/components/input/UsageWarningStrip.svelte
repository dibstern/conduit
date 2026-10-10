<!-- Warn before the composer's Claude account reaches its plan limit. Dismissals
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
	import { clock } from "../../stores/clock.svelte.js";
	import { getInstanceById, instanceState } from "../../stores/instance.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { composerAccountId, usageState } from "../../stores/usage.svelte.js";
	import type { Immutable, SessionInfo } from "../../types.js";
	import { usageWarning } from "../../utils/continuation.js";
	import { openSettings } from "../layout/chrome-actions.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import AccountSwitch from "./AccountSwitch.svelte";

	let { session, projectSlug }: { session: Immutable<SessionInfo> | undefined; projectSlug: string } = $props();

	const key = $derived(session?.id ?? projectSlug);
	const accountId = $derived(composerAccountId(session, projectState.projects.find((project) => project.slug === projectSlug)));
	const reading = $derived(usageState.readings.find((reading) => reading.accountId === accountId && reading.harness === "claude"));
	const severalAccounts = $derived(instanceState.instances.some((instance) => instance.driver === "claude" && instance.id !== accountId));
	const warning = $derived(usageWarning(reading, usageState.limits.warnAt, getInstanceById(accountId ?? "")?.name ?? "Claude", severalAccounts, clock.now));
	const limited = $derived(session?.limitRecovery && !session.limitRecovery.switched);

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
</script>

{#snippet dismiss()}
	<Button variant="ghost" size="content" tone="muted" hoverFill="none" iconOnly icon="x" iconSize={12} ariaLabel="Dismiss usage warning" data-testid="usage-warning-dismiss" class="size-5 shrink-0" onclick={() => {
		if (warning) dismissals.set(key, {
			kind: warning.window.kind,
			...(warning.window.resetsAt === undefined ? {} : { resetsAt: warning.window.resetsAt }),
			below95: warning.window.utilization < 95,
		});
	}} />
{/snippet}

{#if warning && !limited && !dismissals.has(key)}
	<div data-testid="usage-warning-strip" data-window={warning.window.kind} class="usage-warning-strip flex flex-wrap items-center gap-[7px] mb-2 rounded-2xl border px-[10px] py-[7px] text-[11.5px] leading-[1.35] text-text-secondary">
		<Icon name="gauge" size={14} class="shrink-0 text-status-amber" />
		<span class="flex-1 min-w-0"><b data-testid="usage-warning-title" class="font-semibold text-status-amber">{warning.title}</b>{#if warning.detail}{" "}<span data-testid="usage-warning-detail">{warning.detail}</span>{/if}</span>
		{#if sessionViewState.compact}{@render dismiss()}{/if}
		{#if severalAccounts && session && accountId}
			<div class="flex gap-[6px] {sessionViewState.compact ? 'mt-[2px] w-full' : 'shrink-0'}">
				<AccountSwitch sessionId={session.id} {projectSlug} account={accountId} limit={undefined} side="top">
					{#snippet trigger({ props, loading })}
						<Button {...props} variant="secondary" size="content" iconSize={12} {loading} data-testid="usage-warning-switch-account" class="gap-[5px] px-[10px] {sessionViewState.compact ? 'h-[34px] flex-1 justify-center rounded-[10px] text-[12px]' : 'h-[24px] rounded-[8px] text-[11px]'}">
							Switch account{#if !sessionViewState.compact}<Icon name="chevron-down" size={12} />{/if}
						</Button>
					{/snippet}
				</AccountSwitch>
			</div>
		{:else if !severalAccounts && !sessionViewState.compact}
			<TextButton tone="inherit" data-testid="usage-warning-details" class="shrink-0 font-semibold text-status-amber" onclick={() => openSettings("usage")}>Details</TextButton>
		{/if}
		{#if !sessionViewState.compact}{@render dismiss()}{/if}
	</div>
{/if}

<style>
	.usage-warning-strip {
		border-color: color-mix(in srgb, var(--color-status-amber) 38%, transparent);
		background: color-mix(in srgb, var(--color-status-amber) 10%, transparent);
	}
</style>
