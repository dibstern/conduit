<script lang="ts">
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import Select from "../ui/Select.svelte";
	import { themeState, setThemeMode, type ThemeMode } from "../../stores/theme.svelte.js";
</script>

<SettingsGroup id="settings-appearance" title="Appearance">
	<SettingsRow
		label="Theme"
		labelFor="theme-mode"
		description="A fixed appearance, or follow your system"
	>
		{#snippet control()}
			<Select
				id="theme-mode"
				value={themeState.mode}
				onchange={(event) => setThemeMode(event.currentTarget.value as ThemeMode)}
			>
				<option value="light">Light</option>
				<option value="dark">Dark</option>
				<option value="system">System</option>
			</Select>
		{/snippet}
	</SettingsRow>
</SettingsGroup>
