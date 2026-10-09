<!--
  AccountSwitch — moves one Claude session to another account: a picker of the
  Claude accounts with each one's quota checked fresh on every open, then the
  handoff confirm, then ContinueSession on the chosen account. The usage-limit
  strip's Switch account and the session bar's account pill each bring their
  own trigger; only the session moves, never the project's binding.

  The account with the most quota left is pre-selected. Limited accounts and the
  session's own stay visible but can't be picked; an account whose quota can't
  be read can, and the daemon's refusal (not logged in, busy, too large) comes
  back as an error toast with nothing changed.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HandoffSummary, LimitRecovery, QuotaCheckResult } from "../../../contracts/limit-recovery.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { getInstanceById, instanceState } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { continueSessionRpc, previewContinuationRpc, quotaForAccountsRpc } from "../../transport/ws-rpc-client.js";
	import { accountQuota, limitedQuota, quotaBlocksSwitch, quotaHeadroom, quotaReading } from "../../utils/continuation.js";
	import HandoffDialog from "../overlays/HandoffDialog.svelte";
	import AccountDot from "../ui/AccountDot.svelte";
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
	const pickable = (instanceId: string) => instanceId !== account && !quotaBlocksSwitch(quotaOf(instanceId));
	const suggested = $derived.by(() => {
		if (quotas === undefined) return undefined;
		const candidates = accounts.filter((candidate) => pickable(candidate.id));
		return candidates.reduce<(typeof candidates)[number] | undefined>(
			(best, candidate) => (best === undefined || quotaHeadroom(quotaOf(candidate.id)) > quotaHeadroom(quotaOf(best.id)) ? candidate : best),
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
				expectedInstanceId: account,
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
	{side}
	align="end"
	ariaLabel="Continue this session on"
	class={compact ? "px-[14px]" : "w-[320px] px-[10px]"}
	data-testid="account-switch-picker"
>
	{#snippet trigger({ props })}
		{@render switchTrigger({ props, loading: target !== undefined && preview === undefined })}
	{/snippet}
	<div class={compact ? "mt-[4px] mb-[6px] text-[13px] font-semibold text-text" : "my-[4px] font-mono text-[10px] text-text-dimmer"}>Continue this session on</div>
	{#each accounts as option (option.id)}
		{@const selected = option.id === suggested}
		{@const quota = quotaOf(option.id)}
		<MenuItem
			density="compact"
			disabled={!pickable(option.id)}
			data-testid="account-switch-option"
			data-account={option.id}
			data-selected={selected}
			class="rounded-[7px] {selected ? 'bg-border-chip' : ''}"
			onselect={() => void pick(option.id)}
		>
			<AccountDot instanceId={option.id} />
			<span class="min-w-0 truncate {selected ? 'text-text' : 'text-text-secondary'}">{option.name}</span>
			{#if option.id === account}<span class="text-[11px] text-text-dimmer">current</span>{/if}
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
			from: account,
			fromQuota: limit ? limitedQuota(limit) : quotaOf(account),
			quota: quotaOf(chosen),
			cutOff: limit?.cutOffMessageId !== undefined,
			busy,
			onconfirm: () => void switchAccount(chosen),
		}}
	/>
{/if}
