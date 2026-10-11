<!-- Every SettingsGroup shape with real rows, for the story and its baseline. -->
<script lang="ts">
	import SettingsGroup from "../SettingsGroup.svelte";
	import SettingsRow from "../SettingsRow.svelte";
	import TextButton from "../TextButton.svelte";

	let push = $state(true);
	let sound = $state(false);
	let anthropicOpen = $state(true);
	let openaiOpen = $state(false);
</script>

<div class="flex max-w-[520px] flex-col gap-[7px] text-[11.5px] text-text-secondary">
	<SettingsGroup title="Notifications" caption="Alerts for this device only.">
		<SettingsRow
			label="Push notifications"
			description="Alerts this device when a session needs you"
			checked={push}
			onchange={() => (push = !push)}
		/>
		<SettingsRow label="Sound" checked={sound} onchange={() => (sound = !sound)} />
		<SettingsRow label="Locked" description="Disabled rows dim as a whole" checked={true} disabled onchange={() => {}} />
	</SettingsGroup>

	<SettingsGroup title="Composer">
		<SettingsRow label="Controls">
			{#snippet control()}
				<TextButton>Icons</TextButton>
				<TextButton>Words</TextButton>
			{/snippet}
		</SettingsRow>
		<SettingsRow label="Text only" description="A row whose editor sits below it." />
	</SettingsGroup>

	<SettingsGroup collapsible bind:open={anthropicOpen} title="Anthropic" summary="3 of 4 shown">
		{#snippet actions()}<TextButton>Hide all</TextButton>{/snippet}
		<SettingsRow label="Claude Opus 5" checked={true} onchange={() => {}} />
		<SettingsRow label="Claude Sonnet 5" checked={false} onchange={() => {}} />
	</SettingsGroup>

	<SettingsGroup collapsible bind:open={openaiOpen} title="OpenAI" testId="openai-group" summary="12 of 12 shown">
		{#snippet actions()}<TextButton>Hide all</TextButton>{/snippet}
		<SettingsRow label="GPT-6" checked={true} onchange={() => {}} />
	</SettingsGroup>
</div>
