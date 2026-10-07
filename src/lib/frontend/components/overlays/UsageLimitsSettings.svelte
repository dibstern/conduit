<!-- Frame H (2026-10-07 account-switch design): what the daemon does when a
     Claude account reaches its usage limit. Auto-switch arrives with eon2.13. -->
<script lang="ts">
	import { MediaQuery } from "svelte/reactivity";
	import type { UsageLimitsSetting } from "../../../contracts/limit-recovery.js";
	import Toggle from "../ui/Toggle.svelte";
	import { showToast } from "../../stores/ui.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { getUsageLimitsSettingRpc, setUsageLimitsSettingRpc } from "../../transport/ws-rpc-client.js";

	const phone = new MediaQuery("(max-width: 767px)");
	/** `null` until the daemon answers; the toggle stays disabled until then. */
	let setting = $state<UsageLimitsSetting | null>(null);
	let saving = $state(false);
	$effect(() => {
		if (!getIsConnected()) return;
		let current = true;
		void getUsageLimitsSettingRpc()
			.then((loaded) => {
				if (current && !saving) setting = loaded;
			})
			.catch(() => {
				if (current) showToast("Couldn't load usage limit settings", { variant: "error" });
			});
		return () => { current = false; };
	});
	function toggleAutoResume(current: UsageLimitsSetting) {
		saving = true;
		void setUsageLimitsSettingRpc({ ...current, autoResume: !current.autoResume })
			.then((saved) => { setting = saved; })
			.catch(() => showToast("Couldn't save usage limit settings", { variant: "error" }))
			.finally(() => { saving = false; });
	}
</script>

<section id="usage-limit-settings" class="flex flex-col gap-[7px]" aria-labelledby="usage-limit-settings-title">
	<h3 id="usage-limit-settings-title" class="text-[14px] md:text-[13px] font-semibold text-text">
		{phone.current ? "Usage limits" : "When a Claude account reaches its usage limit"}
	</h3>
	<Toggle
		label="Auto-resume limited sessions"
		description={phone.current
			? "Same account, at reset."
			: "Continue the cut-off request on the same account when its limit resets."}
		checked={setting?.autoResume ?? false}
		disabled={setting === null || saving}
		onchange={() => { if (setting) toggleAutoResume(setting); }}
	/>
</section>
