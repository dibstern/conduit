<script lang="ts">
	import SettingsGroup from "../SettingsGroup.svelte";
	import SettingsPicker from "../SettingsPicker.svelte";
	import SettingsRow from "../SettingsRow.svelte";

	let { disabled = false, unavailable = false }: { disabled?: boolean; unavailable?: boolean } = $props();
	let value = $state("80");
</script>

<div class="max-w-[480px]">
	<SettingsGroup title="Composer">
		<SettingsRow label="Context warning" labelFor="story-context-warning" description="Warn when context is this full.">
			{#snippet control()}
				<SettingsPicker id="story-context-warning" label="Context warning" value={unavailable ? "85" : value} {disabled} invalid={unavailable}
					aria-describedby="story-context-warning-hint story-context-warning-help"
					onvaluechange={(next) => { value = next; }} options={[
						...(unavailable ? [{ value: "85", label: "85% (unavailable)", disabled: true }] : []),
						{ value: "60", label: "60%" }, { value: "70", label: "70%" }, { value: "80", label: "80%" }, { value: "90", label: "90%" }, { value: "never", label: "Never" },
					]} />
			{/snippet}
		</SettingsRow>
	</SettingsGroup>
	<p id="story-context-warning-hint" class="sr-only">Warn when context is this full.</p>
	<p id="story-context-warning-help" class="sr-only">Choose Never to turn warnings off.</p>
</div>
