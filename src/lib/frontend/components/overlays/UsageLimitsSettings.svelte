<!-- Frame H (2026-10-07 account-switch design): what the daemon does when a
     Claude account reaches its usage limit. Auto-resume waits for the reset on
     the same account; auto-switch moves to the first account in the order below
     that has quota, and that order is dragged by hand. Every change saves the
     whole setting and shows before the server answers. -->
<script lang="ts">
	import { MediaQuery } from "svelte/reactivity";
	import type { QuotaCheckResult, UsageLimitsSetting } from "../../../contracts/limit-recovery.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { instanceState } from "../../stores/instance.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import {
		getUsageLimitsSettingRpc,
		quotaForAccountsRpc,
		setUsageLimitsSettingRpc,
	} from "../../transport/ws-rpc-client.js";
	import { accountQuota, quotaReading } from "../../utils/continuation.js";
	import AccountDot from "../ui/AccountDot.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";
	import SortableList from "../ui/SortableList.svelte";
	import Toggle from "../ui/Toggle.svelte";

	const phone = new MediaQuery("(max-width: 767px)");
	let setting = $state<UsageLimitsSetting | null>(null);
	/** The last setting the server confirmed, restored when a save fails. */
	let confirmed: UsageLimitsSetting | null = null;
	let saveTicket = 0;
	/** undefined while the check runs. */
	let quotas = $state<ReadonlyMap<string, QuotaCheckResult>>();

	// Accounts the order leaves out go last, in list order, as auto-switch tries them.
	const accounts = $derived.by(() => {
		const order = setting?.order ?? [];
		const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
		return instanceState.instances
			.filter((instance) => instance.driver === "claude")
			.sort((a, b) => rank(a.id) - rank(b.id));
	});
	const accountIds = $derived(accounts.map((account) => account.id).join(","));

	$effect(() => {
		if (!getIsConnected()) return;
		let current = true;
		void getUsageLimitsSettingRpc()
			.then((loaded) => {
				if (current && saveTicket === 0) setting = confirmed = loaded;
			})
			.catch(() => {
				if (current) showToast("Couldn't load usage limit settings", { variant: "error" });
			});
		return () => {
			current = false;
		};
	});

	$effect(() => {
		const projectSlug = getCurrentSlug();
		if (!getIsConnected() || accountIds === "") return;
		if (!projectSlug) {
			quotas = new Map();
			return;
		}
		let current = true;
		quotas = undefined;
		void quotaForAccountsRpc({ projectSlug, originId: getBrowserClientId() })
			.then(({ accounts: checked }) => {
				if (current) quotas = new Map(checked.map((account) => [account.instanceId, account.quota]));
			})
			.catch(() => {
				if (current) quotas = new Map();
			});
		return () => {
			current = false;
		};
	});

	function save(next: UsageLimitsSetting) {
		const ticket = ++saveTicket;
		setting = next;
		void setUsageLimitsSettingRpc(next)
			.then((saved) => {
				confirmed = saved;
				if (ticket === saveTicket) setting = saved;
			})
			.catch(() => {
				if (ticket === saveTicket) setting = confirmed;
				showToast("Couldn't save usage limit settings", { variant: "error" });
			});
	}
</script>

<section id="usage-limit-settings" class="flex flex-col gap-[7px]" aria-labelledby="usage-limit-settings-title">
	<h3 id="usage-limit-settings-title" class="text-[14px] md:text-[13px] font-semibold text-text">{phone.current ? "Usage limits" : "When a Claude account reaches its usage limit"}</h3>
	<Toggle
		label="Auto-resume limited sessions"
		description={phone.current ? "Same account, at reset." : "Continue the cut-off request on the same account when its limit resets."}
		checked={setting?.autoResume ?? false}
		disabled={setting === null}
		onchange={() => {
			if (setting) save({ ...setting, autoResume: !setting.autoResume });
		}}
	/>
	<Toggle
		label={phone.current ? "Auto-switch account" : "Auto-switch account when limited"}
		ariaLabel="Toggle auto-switch account when limited"
		description={phone.current ? "First account with quota." : "Move the session to the first account below that has quota. Runs before auto-resume."}
		checked={setting?.autoSwitch ?? false}
		disabled={setting === null}
		onchange={() => {
			if (setting) save({ ...setting, autoSwitch: !setting.autoSwitch });
		}}
	/>
	{#if accounts.length > 1}
		<SortableList
			items={accounts}
			key={(account) => account.id}
			label={(account) => account.name}
			ariaLabel="Auto-switch account order"
			disabled={setting === null}
			onreorder={(next) => {
				if (setting) save({ ...setting, order: next.map((account) => account.id) });
			}}
		>
			{#snippet row(account, index)}
				{#if !phone.current}<span class="font-mono text-[10.5px] text-text-secondary">{index + 1}</span>{/if}
				<AccountDot instanceId={account.id} />
				<span data-testid="usage-limit-account-name" class="min-w-0 flex-1 truncate">{account.name}</span>
				<QuotaMeter {...quotaReading(accountQuota(quotas, account.id))} size="lg" track={!phone.current} />
			{/snippet}
		</SortableList>
	{/if}
</section>
