<script lang="ts">
	import Surface from "../ui/Surface.svelte";
	import Select from "../ui/Select.svelte";
	import { themeState, setThemeMode, type ThemeMode } from "../../stores/theme.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { setAutoSettleSettingRpc } from "../../transport/ws-rpc-client.js";
	let { state = $bindable() }: { state: { autoSettleDays: number | null; autoSettleSaving: boolean } } = $props();
</script>

<Surface variant="card" padding="lg" radius="panel" class="font-brand">
	<label for="theme-mode" class="block text-base font-medium text-text">
		Theme
	</label>
	<p class="mt-1 text-xs text-text-muted">
		Choose a fixed appearance or follow your system setting.
	</p>
	<Select
		id="theme-mode"
		value={themeState.mode}
		class="mt-3 w-full"
		onchange={(event) =>
			setThemeMode(
				(event.currentTarget as HTMLSelectElement).value as ThemeMode,
			)}
	>
		<option value="light">Light</option>
		<option value="dark">Dark</option>
		<option value="system">System</option>
	</Select>
</Surface>
<Surface variant="card" padding="lg" radius="panel" class="mt-4 font-brand">
	<label for="settings-auto-settle-select" class="block text-base font-medium text-text">Settle idle sessions after</label>
	<Select
		id="settings-auto-settle-select"
		data-testid="settings-auto-settle-select"
		value={state.autoSettleDays === null ? "never" : String(state.autoSettleDays)}
		disabled={state.autoSettleSaving}
		class="mt-3 w-full"
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
	<p class="mt-1 text-xs text-text-muted">
		Settled sessions move to the Settled shelf. Nothing is deleted.
	</p>
</Surface>
