<script lang="ts">
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import Select from "../ui/Select.svelte";
	import { showToast } from "../../stores/ui.svelte.js";
	import { getCurrentRoute, getCurrentSlug } from "../../stores/router.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { getAutoSettleSettingRpc, setAutoSettleSettingRpc } from "../../transport/ws-rpc-client.js";
	let state = $state({ autoSettleDays: 3 as number | null, autoSettleSaving: false });

	$effect(() => {
		if (!getIsConnected()) return;
		const route = getCurrentRoute();
		if (route.page === "chat" && route.sessionId && !getCurrentSlug()) return;
		let current = true;
		void getAutoSettleSettingRpc()
			.then((days) => {
				if (current && !state.autoSettleSaving) state.autoSettleDays = days;
			})
			.catch(() => {
				if (current) showToast("Couldn't load auto-settle setting", { variant: "error" });
			});
		return () => { current = false; };
	});
</script>

<SettingsGroup id="settings-sessions" title="Sessions">
	<SettingsRow
		label="Settle idle sessions after"
		labelFor="settings-auto-settle-select"
		description="Moves to the Settled shelf. Nothing is deleted."
	>
		{#snippet control()}
			<Select
				id="settings-auto-settle-select"
				data-testid="settings-auto-settle-select"
				value={state.autoSettleDays === null ? "never" : String(state.autoSettleDays)}
				disabled={state.autoSettleSaving}
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
		{/snippet}
	</SettingsRow>
</SettingsGroup>
