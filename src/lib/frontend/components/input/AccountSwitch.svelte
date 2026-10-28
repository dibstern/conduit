<!--
  AccountSwitch — moves one session to another account of the same provider:
  accounts with each one's quota checked fresh on every open, then the
  handoff confirm, then ContinueSession on the chosen account. The usage-limit
  strip's Switch account brings its own trigger; only the session moves, never
  the project's binding.

  The account with the most quota left is pre-selected. Limited accounts and the
  session's own stay visible but can't be picked; an account whose quota can't
  be read can, and the daemon's refusal (not logged in, busy, too large) comes
  back as an error toast with nothing changed.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import { accountLimit } from "../../../contracts/account-limit.js";
	import type { LimitRecovery } from "../../../contracts/limit-recovery.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { getClaudeAccounts } from "../../stores/claude-accounts.svelte.js";
	import { getDriverTraits, getInstanceById } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { quotaReading } from "../../utils/continuation.js";
	import HandoffDialog from "../overlays/HandoffDialog.svelte";
	import HarnessLogo from "../model/HarnessLogo.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";

	let {
		sessionId,
		projectSlug,
		account,
		limit,
		side,
		// Menu's own trigger snippet below would shadow the prop's name.
		trigger: switchTrigger,
	}: {
		sessionId: string;
		projectSlug: string;
		/** The session's current account: the one it moves from. */
		account: string;
		/** The session's open usage limit, when it has one. */
		limit: LimitRecovery | undefined;
		/** Which side of the trigger the popover opens on (phones get a sheet). */
		side: "top" | "bottom";
		/** `loading` while the picked account's handoff preview is on its way. */
		trigger: Snippet<[{ props: Record<string, unknown>; loading: boolean }]>;
	} = $props();

	const compact = $derived(sessionViewState.compact);
	const claudeAccounts = $derived(getClaudeAccounts(projectSlug, getDriverTraits(getInstanceById(account)?.driver)?.usageHarness === "codex" ? "codex" : "claude"));
	const accounts = $derived(claudeAccounts.configuredAccounts);

	let pickerOpen = $state(false);
	// Two triggers can be mounted for one session; only the one picked hosts its dialog.
	let presentedRequest = $state<number | undefined>();
	const handoff = $derived(claudeAccounts.pendingHandoff?.requestId === presentedRequest ? claudeAccounts.pendingHandoff : undefined);
	const loading = $derived(claudeAccounts.handoff.kind === "previewing" && claudeAccounts.handoff.requestId === presentedRequest);
	const suggested = $derived(claudeAccounts.suggestedAccount(account));
</script>

<Menu
	bind:open={pickerOpen}
	onopenchange={(open) => {
		if (open) void claudeAccounts.refreshQuotas();
	}}
	presentation={compact ? "sheet" : "popover"}
	{side}
	align="end"
	ariaLabel="Continue this session on"
	class={compact ? "px-[14px]" : "w-[320px] px-[10px]"}
	data-testid="account-switch-picker"
>
	{#snippet trigger({ props })}
		{@render switchTrigger({ props, loading })}
	{/snippet}
	<div class={compact ? "mt-[4px] mb-[6px] text-[13px] font-semibold text-text" : "my-[4px] font-mono text-[10px] text-text-dimmer"}>Continue this session on</div>
	{#each accounts as option (option.id)}
		{@const selected = option.id === suggested}
		{@const quota = claudeAccounts.quotaOf(option.id)}
		{@const choice = claudeAccounts.availabilityOf(option.id, account)}
		<MenuItem
			density="compact"
			disabled={choice.kind !== "selectable"}
			data-testid="account-switch-option"
			data-account={option.id}
			data-selected={selected}
			class="rounded-[7px] {selected ? 'bg-border-chip' : ''}"
			onselect={() => {
				void claudeAccounts.beginSwitch(sessionId, option.id, account);
				presentedRequest = claudeAccounts.handoff.kind === "previewing" ? claudeAccounts.handoff.requestId : undefined;
			}}
		>
			<HarnessLogo driver={getInstanceById(option.id)?.driver ?? claudeAccounts.harness} instanceId={option.id} size={15} aligned spinning={option.id === claudeAccounts.switchingTo && claudeAccounts.shouldAccountSpin(sessionId, option.id)} data-testid="account-logo" />
			<span class="min-w-0 truncate {selected ? 'text-text' : 'text-text-secondary'}">{option.name}</span>
			{#if option.id === account}<span class="text-[11px] text-text-dimmer">current</span>{/if}
			<span class="flex-1"></span>
			<!-- A limited row's red caption says it all; a full red track would crowd its name out. -->
			{#if choice.kind === "selectable" && choice.usageUnknown}
				<QuotaMeter used="unknown" caption="usage unknown" size={compact ? "sm" : "md"} track={false} />
			{:else}
				<QuotaMeter {...quotaReading(quota, clock.now)} size={compact ? "sm" : "md"} track={accountLimit({ asker: "user", ...(quota ? { reading: quota } : {}), now: clock.now }).kind !== "wait-until"} />
			{/if}
		</MenuItem>
	{/each}
	{#if !compact}
		<div class="-mx-[10px] mt-[4px] border-t border-border-subtle px-[10px] pt-[8px] pb-[5px] text-[10.5px] text-text-muted">You'll see what carries over before anything changes.</div>
	{/if}
</Menu>

{#if handoff}
	{@const chosen = handoff.to}
	<HandoffDialog
		open
		onclose={() => claudeAccounts.cancel()}
		to={chosen}
		summary={handoff.summary}
		confirm={{
			from: handoff.from,
			fromQuota: claudeAccounts.quotaOf(handoff.from),
			quota: claudeAccounts.quotaOf(chosen),
			cutOff: limit?.cutOffMessageId !== undefined,
			busy: claudeAccounts.switching,
			onconfirm: () => void claudeAccounts.confirm(),
		}}
	/>
{/if}
