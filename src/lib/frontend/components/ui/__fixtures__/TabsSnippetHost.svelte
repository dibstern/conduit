<script lang="ts">
	import Tabs from "../Tabs.svelte";
	import type { SegmentedOption } from "../segmented-styles.js";
	import Badge from "../Badge.svelte";
	import Icon from "../Icon.svelte";
	let { value: _value, options: _options, label: _label }: { value: string; options: readonly SegmentedOption[]; label: string } = $props();

	let selected = $state("chat");
	const options = [
		{ value: "chat", label: "Chat" },
		{ value: "terminal", label: "Terminal" },
		{ value: "diff", label: "Diff", disabled: true },
	];
</script>

<Tabs bind:value={selected} {options} label="Session views" variant="switcher">
	{#snippet optionContent(option, isSelected)}
		<Icon name={option.value === "chat" ? "message-square" : "square-terminal"} size={16} />
		<span data-testid={`content-${option.value}`}>{option.label} {isSelected ? "selected" : "idle"}</span>
		{#if option.value === "terminal"}<Badge variant="accent-solid" size="count" shape="pill">2</Badge>{/if}
		{#if option.value === "terminal"}<span>⌘J</span>{/if}
	{/snippet}
</Tabs>
