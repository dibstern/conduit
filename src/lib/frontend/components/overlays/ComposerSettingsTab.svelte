<script lang="ts">
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import SettingsPicker from "../ui/SettingsPicker.svelte";
	import {
		composerPreferences,
		setComposerPreferences,
	} from "../../stores/composer-preferences.svelte.js";

	const controls = [
		{ value: "icons", label: "Icons", testId: "settings-composer-controls-icons" },
		{ value: "words", label: "Words", testId: "settings-composer-controls-words" },
	] as const;
	const contextWarnings = [
		{ value: "60", label: "60%", testId: "settings-composer-context-warning-60" },
		{ value: "70", label: "70%", testId: "settings-composer-context-warning-70" },
		{ value: "80", label: "80%", testId: "settings-composer-context-warning-80" },
		{ value: "90", label: "90%", testId: "settings-composer-context-warning-90" },
		{ value: "never", label: "Never", testId: "settings-composer-context-warning-never" },
	] as const;
</script>

<SettingsGroup id="settings-composer" title="Composer">
	<SettingsRow
		label="Controls"
		description="Icons puts model, effort and approvals in the composer as icon buttons. Words lists them as text under the field."
	>
		{#snippet control()}
			<SegmentedControl
				bind:value={() => composerPreferences.controls, (controls) => setComposerPreferences({ controls })}
				options={controls}
				label="Controls"
				variant="joined"
			/>
		{/snippet}
	</SettingsRow>
	<SettingsRow
		label="Context warning"
		labelFor="settings-composer-context-warning"
		description="Warn when context is this full. Shows the Compact bar and turns the context % amber. Never hides both."
	>
		{#snippet control()}
			<SettingsPicker
				id="settings-composer-context-warning"
				data-testid="settings-composer-context-warning"
				value={String(composerPreferences.contextWarning)}
				onvaluechange={(value) => setComposerPreferences({ contextWarning: value === "never" ? "never" : Number(value) as 60 | 70 | 80 | 90 })}
				options={contextWarnings}
				label="Context warning"
			/>
		{/snippet}
	</SettingsRow>
</SettingsGroup>
