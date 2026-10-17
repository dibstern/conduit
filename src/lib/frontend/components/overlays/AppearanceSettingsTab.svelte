<script lang="ts">
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import SettingsPicker from "../ui/SettingsPicker.svelte";
	import { themeState, setThemeMode } from "../../stores/theme.svelte.js";
</script>

<SettingsGroup id="settings-appearance" title="Appearance">
	<SettingsRow
		label="Theme"
		labelFor="theme-mode"
		description="A fixed appearance, or follow your system"
	>
		{#snippet control()}
			<SettingsPicker
				id="theme-mode"
				label="Theme"
				value={themeState.mode}
				onvaluechange={(mode) => { if (mode === "light" || mode === "dark" || mode === "system") setThemeMode(mode); }}
				options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "System" }]}
			/>
		{/snippet}
	</SettingsRow>
</SettingsGroup>
