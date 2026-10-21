<script lang="ts">
	import {
		getSessionGrouping,
		setSessionGrouping,
		type SessionGrouping,
	} from "../../stores/session-scope.js";
	import { projectTreeState, setProjectSort, type ProjectSort } from "../../stores/project-tree.svelte.js";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuGroup from "../ui/MenuGroup.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";

	let { compact = false }: { compact?: boolean } = $props();
	const grouping = $derived(getSessionGrouping());
	const choices: { value: SessionGrouping; label: string; hint?: string }[] = [
		{ value: "status", label: "Status", hint: "what wants you" },
		{ value: "project", label: "Project" },
		{ value: "time", label: "Time", hint: "today · yesterday · older" },
	];
	const sorts: { value: ProjectSort; label: string; hint?: string }[] = [
		{ value: "recent", label: "Last user message" },
		{ value: "created", label: "Created" },
		{ value: "manual", label: "Manual", hint: "drag to reorder" },
	];
	const itemClass = $derived(compact ? "min-h-[44px] md:min-h-0" : undefined);
</script>

{#snippet choiceLabel(choice: { label: string; hint?: string | undefined })}
	<span class="flex min-w-0 flex-1 items-center gap-2">
		<span>{choice.label}</span>
		{#if choice.hint}<span class="text-text-dimmer text-xs">{choice.hint}</span>{/if}
	</span>
{/snippet}

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
			<MenuRadioItem value={choice.value} data-testid={`session-group-option-${choice.value}`} class={itemClass}>
				{@render choiceLabel(choice)}
			</MenuRadioItem>
		{/each}
	</MenuRadioGroup>
	{#if grouping === "project"}
		<MenuSeparator />
		<MenuGroup label="Sort projects">
			<MenuRadioGroup value={projectTreeState.sort} onvaluechange={(value) => { const sort = sorts.find((s) => s.value === value); if (sort) setProjectSort(sort.value); }}>
				{#each sorts as sort (sort.value)}
					<MenuRadioItem value={sort.value} data-testid={`project-sort-option-${sort.value}`} class={itemClass}>
						{@render choiceLabel(sort)}
					</MenuRadioItem>
				{/each}
			</MenuRadioGroup>
		</MenuGroup>
	{/if}
</Menu>
