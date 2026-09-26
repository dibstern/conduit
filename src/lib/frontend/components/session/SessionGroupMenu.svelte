<script lang="ts">
	import {
		getSessionGrouping,
		setSessionGrouping,
		type SessionGrouping,
	} from "../../stores/session-scope.js";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";

	let { compact = false }: { compact?: boolean } = $props();
	const grouping = $derived(getSessionGrouping());
	const choices: { value: SessionGrouping; label: string; hint?: string }[] = [
		{ value: "status", label: "Status", hint: "what wants you" },
		{ value: "project", label: "Project" },
		{ value: "time", label: "Time", hint: "today · yesterday · older" },
	];
</script>

<Menu ariaLabel="Group sessions" align="end">
	{#snippet trigger({ props })}
		<Button
			{...props}
			variant="toolbar"
			size="content"
			iconOnly
			icon="arrow-up-down"
			iconSize={17}
			class={compact ? "shrink-0 min-h-[44px] min-w-[44px] justify-center rounded-lg" : "h-8 w-8 rounded-md"}
			title="Group sessions"
			ariaLabel="Group sessions"
			data-testid="session-group-button"
		/>
	{/snippet}
	<MenuRadioGroup value={grouping} onvaluechange={(value) => { const choice = choices.find((c) => c.value === value); if (choice) setSessionGrouping(choice.value); }}>
		{#each choices as choice (choice.value)}
			<MenuRadioItem value={choice.value} data-testid={`session-group-option-${choice.value}`}>
				<span class="flex min-w-0 flex-1 items-center gap-2">
					<span>{choice.label}</span>
					{#if choice.hint}<span class="text-text-dimmer text-xs">{choice.hint}</span>{/if}
				</span>
			</MenuRadioItem>
		{/each}
	</MenuRadioGroup>
</Menu>
