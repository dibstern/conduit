<!--
  AccountSwitch — the usage-limit strip's Switch account: a picker of the
  session's Claude accounts with each one's quota checked fresh on every open,
  then the handoff confirm, then ContinueSession on the chosen account.

  The account with the most quota left is pre-selected. Limited accounts and the
  session's own stay visible but can't be picked; an account whose quota can't
  be read can, and the daemon's refusal (not logged in, busy, too large) comes
  back as an error toast with nothing changed. The strip itself leaves once the
  switch goes out.
-->
<script lang="ts">
	import type { HandoffSummary, LimitRecovery, QuotaCheckResult } from "../../../contracts/limit-recovery.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { getInstanceById, instanceState } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { continueSessionRpc, previewContinuationRpc, quotaForAccountsRpc } from "../../transport/ws-rpc-client.js";
	import { accountQuota, quotaBlocksSwitch, quotaHeadroom, quotaReading } from "../../utils/continuation.js";
	import HandoffDialog from "../overlays/HandoffDialog.svelte";
	import AccountDot from "../ui/AccountDot.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";

	let {
		limitRecovery,
		sessionId,
		projectSlug,
		primary,
		class: className,
	}: {
		limitRecovery: LimitRecovery;
		sessionId: string;
		projectSlug: string;
		/** The strip's main action (limited), or second to a scheduled resume. */
		primary: boolean;
		/** The strip's button geometry. */
		class: string;
	} = $props();

	const compact = $derived(sessionViewState.compact);
	const accounts = $derived(instanceState.instances.filter((instance) => instance.driver === "claude"));

	let pickerOpen = $state(false);
	// undefined while the check runs; a failed check reads as unknown everywhere.
	let quotas = $state<ReadonlyMap<string, QuotaCheckResult> | undefined>();
	let target = $state<string | undefined>();
	let preview = $state<HandoffSummary | undefined>();
	let busy = $state(false);
	// Only the latest open's or pick's answer counts.
	let quotaTicket = 0;
	let previewTicket = 0;

	const quotaOf = (instanceId: string) => accountQuota(quotas, instanceId);
	const pickable = (instanceId: string) => instanceId !== limitRecovery.instanceId && !quotaBlocksSwitch(quotaOf(instanceId));
	const suggested = $derived.by(() => {
		if (quotas === undefined) return undefined;
		const candidates = accounts.filter((account) => pickable(account.id));
		return candidates.reduce<(typeof candidates)[number] | undefined>(
			(best, account) => (best === undefined || quotaHeadroom(quotaOf(account.id)) > quotaHeadroom(quotaOf(best.id)) ? account : best),
			undefined,
		)?.id;
	});

	async function checkQuotas(): Promise<void> {
		const ticket = ++quotaTicket;
		quotas = undefined;
		try {
			const { accounts: checked } = await quotaForAccountsRpc({ projectSlug, originId: getBrowserClientId() });
			if (ticket === quotaTicket) quotas = new Map(checked.map((account) => [account.instanceId, account.quota]));
		} catch {
			if (ticket === quotaTicket) quotas = new Map();
		}
	}

	// The confirm opens once the preview has the real message count.
	async function pick(instanceId: string): Promise<void> {
		const ticket = ++previewTicket;
		target = instanceId;
		preview = undefined;
		try {
			const summary = await previewContinuationRpc({ projectSlug, sessionId, instanceId, originId: getBrowserClientId() });
			if (ticket === previewTicket) preview = summary;
		} catch (error) {
			if (ticket !== previewTicket) return;
			target = undefined;
			refused(instanceId, error);
		}
	}

	// The daemon's reason (not logged in, busy, too large) under which account it was.
	function refused(instanceId: string, error: unknown): void {
		showToast({
			title: `Couldn't switch to ${getInstanceById(instanceId)?.name ?? instanceId}`,
			...(error instanceof Error && error.message ? { body: error.message } : {}),
			variant: "error",
		});
	}

	function closeConfirm(): void {
		previewTicket++;
		target = undefined;
		preview = undefined;
	}

	async function switchAccount(instanceId: string): Promise<void> {
		busy = true;
		try {
			await continueSessionRpc({
				projectSlug,
				sessionId,
				instanceId,
				expectedInstanceId: limitRecovery.instanceId,
				originId: getBrowserClientId(),
			});
			closeConfirm();
		} catch (error) {
			closeConfirm();
			refused(instanceId, error);
		} finally {
			busy = false;
		}
	}
</script>

<Menu
	bind:open={pickerOpen}
	onopenchange={(open) => {
		if (open) void checkQuotas();
	}}
	presentation={compact ? "sheet" : "popover"}
	side="top"
	align="end"
	ariaLabel="Continue this session on"
	class={compact ? "px-[14px]" : "w-[320px] px-[10px]"}
	data-testid="account-switch-picker"
>
	{#snippet trigger({ props })}
		<Button
			{...props}
			variant={primary ? "inverse" : "secondary"}
			size="content"
			iconSize={12}
			loading={target !== undefined && preview === undefined}
			data-testid="usage-limit-switch-account"
			class="gap-[5px] {primary ? 'font-semibold' : ''} {compact ? 'justify-center' : ''} {className}"
		>
			Switch account{#if !compact}<Icon name="chevron-down" size={12} />{/if}
		</Button>
	{/snippet}
	<div class={compact ? "mt-[4px] mb-[6px] text-[13px] font-semibold text-text" : "my-[4px] font-mono text-[10px] text-text-dimmer"}>Continue this session on</div>
	{#each accounts as account (account.id)}
		{@const selected = account.id === suggested}
		{@const quota = quotaOf(account.id)}
		<MenuItem
			density="compact"
			disabled={!pickable(account.id)}
			data-testid="account-switch-option"
			data-account={account.id}
			data-selected={selected}
			class="rounded-[7px] {selected ? 'bg-border-chip' : ''}"
			onselect={() => void pick(account.id)}
		>
			<AccountDot instanceId={account.id} />
			<span class="min-w-0 truncate {selected ? 'text-text' : 'text-text-secondary'}">{account.name}</span>
			{#if account.id === limitRecovery.instanceId}<span class="text-[11px] text-text-dimmer">current</span>{/if}
			<span class="flex-1"></span>
			<!-- A limited row's red caption says it all; a full red track would crowd its name out. -->
			<QuotaMeter {...quotaReading(quota)} size={compact ? "sm" : "md"} track={!quotaBlocksSwitch(quota)} />
		</MenuItem>
	{/each}
	{#if !compact}
		<div class="-mx-[10px] mt-[4px] border-t border-border-subtle px-[10px] pt-[8px] pb-[5px] text-[10.5px] text-text-muted">You'll see what carries over before anything changes.</div>
	{/if}
</Menu>

{#if target !== undefined && preview !== undefined}
	{@const chosen = target}
	<HandoffDialog
		open
		onclose={closeConfirm}
		to={chosen}
		summary={preview}
		confirm={{
			from: limitRecovery.instanceId,
			quota: quotaOf(chosen),
			cutOff: limitRecovery.cutOffMessageId !== undefined,
			busy,
			onconfirm: () => void switchAccount(chosen),
		}}
	/>
{/if}
