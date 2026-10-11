<script lang="ts">
	import { MediaQuery } from "svelte/reactivity";
	import type { UsageLimitsSetting } from "../../../contracts/limit-recovery.js";
	import Toggle from "../ui/Toggle.svelte";

	let { setting, several, onsave }: {
		setting: UsageLimitsSetting | null;
		several: boolean;
		onsave: (next: UsageLimitsSetting) => void;
	} = $props();
	const phone = new MediaQuery("(max-width: 767px)");
</script>

<section id="usage-limit-settings" class="mt-[16px] flex flex-col gap-[4px]" aria-labelledby="usage-limit-settings-title">
	<h3 id="usage-limit-settings-title" class="text-[12.5px] font-semibold text-text">{several ? "When an account reaches its limit" : "When the account reaches its limit"}</h3>
	<Toggle
		label="Auto-resume limited sessions"
		description={phone.current ? "Same account, at reset." : "Continue the cut-off request on the same account when its limit resets."}
		checked={setting?.autoResume ?? false}
		disabled={setting === null}
		onchange={() => {
			if (setting) onsave({ ...setting, autoResume: !setting.autoResume });
		}}
	/>
	{#if several}
		<Toggle
			label={phone.current ? "Auto-switch account" : "Auto-switch account when limited"}
			ariaLabel="Toggle auto-switch account when limited"
			description={phone.current ? "First account above with quota." : "Move the session to the first account above that has quota. Runs before auto-resume."}
			checked={setting?.autoSwitch ?? false}
			disabled={setting === null}
			onchange={() => {
				if (setting) onsave({ ...setting, autoSwitch: !setting.autoSwitch });
			}}
		/>
	{/if}
</section>
