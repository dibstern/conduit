<script lang="ts">
	import Select from "../ui/Select.svelte";
	import { themeState, setThemeMode, type ThemeMode } from "../../stores/theme.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { setAutoSettleSettingRpc } from "../../transport/ws-rpc-client.js";
	let { state = $bindable() }: { state: { autoSettleDays: number | null; autoSettleSaving: boolean } } = $props();
</script>

<div class="py-[8px] border-b border-border-subtle">
	<label for="theme-mode" class="block font-semibold text-text mb-[2px]">Theme</label>
	<p>Choose a fixed appearance or follow your system setting.</p>
	<Select
		id="theme-mode"
		value={themeState.mode}
		class="mt-[8px] w-full md:max-w-[260px]"
		onchange={(event) =>
			setThemeMode(
				(event.currentTarget as HTMLSelectElement).value as ThemeMode,
			)}
	>
		<option value="light">Light</option>
		<option value="dark">Dark</option>
		<option value="system">System</option>
	</Select>
</div>
<div class="py-[8px] border-b border-border-subtle">
	<label for="settings-auto-settle-select" class="block font-semibold text-text mb-[2px]">Settle idle sessions after</label>
	<p>Settled sessions move to the Settled shelf. Nothing is deleted.</p>
	<Select
		id="settings-auto-settle-select"
		data-testid="settings-auto-settle-select"
		value={state.autoSettleDays === null ? "never" : String(state.autoSettleDays)}
		disabled={state.autoSettleSaving}
		class="mt-[8px] w-full md:max-w-[260px]"
		onchange={(event) => {
			const value = event.currentTarget.value;
			const next = value === "never" ? null : Number(value);
			state.autoSettleSaving = true;
			void setAutoSettleSettingRpc(next)
				.then((days) => {
					state.autoSettleDays = days;
				})
				.catch(() => {
					showToast("Couldn't save auto-settle setting", { variant: "error" });
				})
				.finally(() => {
					state.autoSettleSaving = false;
				});
		}}
	>
		<option value="1">1 day</option>
		<option value="2">2 days</option>
		<option value="3">3 days</option>
		<option value="7">1 week</option>
		<option value="14">2 weeks</option>
		<option value="30">30 days</option>
		<option value="90">90 days</option>
		<option value="never">Never</option>
	</Select>
</div>
