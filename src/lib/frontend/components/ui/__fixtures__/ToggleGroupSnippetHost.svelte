<script lang="ts">
	import ToggleGroup from "../ToggleGroup.svelte";
	let { rail = false }: { rail?: boolean | undefined } = $props();
	let active = $state(["chat"]);
	const options = [
		{ value: "chat", label: "Chat" },
		{ value: "terminal", label: "Terminal" },
		{ value: "diff", label: "Diff", disabled: true },
	];
</script>

<ToggleGroup
	value={active}
	{options}
	variant={rail ? "rail" : "switcher"}
	orientation={rail ? "vertical" : "horizontal"}
	label="Session views"
	onToggle={(value) => {
		active = active.includes(value)
			? active.filter((item) => item !== value)
			: [...active, value];
	}}
>
	{#snippet optionContent(option, pressed)}
		<span data-testid={`content-${option.value}`}>
			{option.label} {pressed ? "on" : "off"}
			{#if option.value === "terminal"}
				<kbd class="rounded border border-border px-1 text-xs text-text-muted">⌘J</kbd>
			{/if}
		</span>
	{/snippet}
</ToggleGroup>
