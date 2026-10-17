<script lang="ts">
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import type { UsageLimitsSetting } from "../../../contracts/limit-recovery.js";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import SettingsPicker from "../ui/SettingsPicker.svelte";

	const warnOptions = [70, 80, 90, "off"] as const;

	let { setting, several, onsave }: {
		setting: UsageLimitsSetting | null;
		several: boolean;
		onsave: (next: UsageLimitsSetting) => void;
	} = $props();
</script>

<SettingsGroup id="usage-limit-settings" title="Limits">
	<SettingsRow label="Warn me at" labelFor="usage-settings-warn">
		{#snippet control()}
			<SettingsPicker
				id="usage-settings-warn"
				data-testid="usage-settings-warn"
				disabled={setting === null}
				label="Warn me at"
				options={warnOptions.map((warnAt) => ({ value: String(warnAt), label: warnAt === "off" ? "off" : `${warnAt}%`, testId: `usage-settings-warn-${warnAt}` }))}
				value={String(setting?.warnAt ?? 80)}
				onvaluechange={(next) => {
					const warnAt = warnOptions.find((option) => String(option) === next);
					if (setting && warnAt !== undefined) onsave({ ...setting, warnAt });
				}}
			/>
		{/snippet}
	</SettingsRow>
	<SettingsRow
		label="Auto-resume limited sessions"
		description={sessionViewState.compact ? "Same account, at reset." : "Continue the cut-off request on the same account when its limit resets."}
		checked={setting?.autoResume ?? false}
		disabled={setting === null}
		onchange={() => {
			if (setting) onsave({ ...setting, autoResume: !setting.autoResume });
		}}
	/>
	{#if several}
		<SettingsRow
			label={sessionViewState.compact ? "Auto-switch account" : "Auto-switch account when limited"}
			ariaLabel="Toggle auto-switch account when limited"
			description={sessionViewState.compact ? "First account above with quota." : "Move the session to the first account above that has quota. Runs before auto-resume."}
			checked={setting?.autoSwitch ?? false}
			disabled={setting === null}
			onchange={() => {
				if (setting) onsave({ ...setting, autoSwitch: !setting.autoSwitch });
			}}
		/>
	{/if}
</SettingsGroup>
