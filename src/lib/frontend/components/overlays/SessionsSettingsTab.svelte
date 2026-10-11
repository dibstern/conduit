<script lang="ts">
	import { untrack } from "svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import Select from "../ui/Select.svelte";
	import { Schema } from "effect";
	import { GroupingModeSchema } from "../../../shared-types.js";
	import { projectState } from "../../stores/project-state.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { getCurrentRoute, getCurrentSlug } from "../../stores/router.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { getAutoSettleSettingRpc, setAutoSettleSettingRpc, getDefaultGroupingModeRpc, setDefaultGroupingModeRpc } from "../../transport/ws-rpc-client.js";
	let state = $state({ autoSettleDays: 3 as number | null, autoSettleSaving: false, groupingSaving: false });

	$effect(() => {
		if (!getIsConnected()) return;
		const route = getCurrentRoute();
		if (route.page === "chat" && route.sessionId && !getCurrentSlug()) return;
		let current = true;
		const groupingReadRevision = untrack(() => projectState.defaultGroupingRevision);
		void getAutoSettleSettingRpc()
			.then((days) => {
				if (current && !state.autoSettleSaving) state.autoSettleDays = days;
			})
			.catch(() => {
				if (current) showToast("Couldn't load auto-settle setting", { variant: "error" });
			});
		void getDefaultGroupingModeRpc()
			.then((mode) => {
				if (current && groupingReadRevision === projectState.defaultGroupingRevision) projectState.defaultGroupingMode = mode;
			})
			.catch(() => {
				if (current) showToast("Couldn't load grouping setting", { variant: "error" });
			});
		return () => { current = false; };
	});
</script>

<SettingsGroup id="settings-sessions" title="Sessions">
	<SettingsRow label="Default repository grouping" labelFor="settings-grouping-mode-select" description="Projects inherit this unless they choose their own mode.">
		{#snippet control()}
			<Select id="settings-grouping-mode-select" value={projectState.defaultGroupingMode} disabled={state.groupingSaving} onchange={(event) => {
				const mode = event.currentTarget.value;
				if (!Schema.is(GroupingModeSchema)(mode)) return;
				const groupingSaveRevision = ++projectState.defaultGroupingRevision;
				state.groupingSaving = true;
				void setDefaultGroupingModeRpc(mode)
					.then((saved) => {
						if (groupingSaveRevision === projectState.defaultGroupingRevision) projectState.defaultGroupingMode = saved;
					})
					.catch(() => { showToast("Couldn't save grouping setting", { variant: "error" }); })
					.finally(() => { state.groupingSaving = false; });
			}}>
				<option value="repository">By repository</option>
				<option value="repository+subfolder">By repository and subfolder</option>
				<option value="off">Off</option>
			</Select>
		{/snippet}
	</SettingsRow>
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
