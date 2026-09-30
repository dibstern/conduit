<script lang="ts">
	import Menu from "../Menu.svelte";
	import MenuCheckboxItem from "../MenuCheckboxItem.svelte";
	import MenuGroup from "../MenuGroup.svelte";
	import MenuItem from "../MenuItem.svelte";
	import MenuRadioGroup from "../MenuRadioGroup.svelte";
	import MenuRadioItem from "../MenuRadioItem.svelte";
	import MenuSeparator from "../MenuSeparator.svelte";

	let {
		open = $bindable(true),
		selected = $bindable("shared"),
		checked = $bindable(true),
		presentation = "popover",
	}: {
		open?: boolean;
		selected?: string;
		checked?: boolean;
		presentation?: "popover" | "sheet";
	} = $props();
</script>

<output class="sr-only" data-testid="selected-value">{selected}</output>
<output class="sr-only" data-testid="checked-value">{String(checked)}</output>

<Menu bind:open {presentation} ariaLabel="File actions" class="min-w-44">
	{#snippet trigger({ props })}
		<button
			{...props}
			class="rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:bg-bg-alt"
		>
			Open menu
		</button>
	{/snippet}

	<MenuGroup label="Project">
		<MenuItem icon="archive">Archive</MenuItem>
		<MenuItem>Duplicate</MenuItem>
		<MenuCheckboxItem bind:checked>Auto-settle when idle</MenuCheckboxItem>
		<MenuSeparator />
		<MenuRadioGroup bind:value={selected}>
			<MenuRadioItem value="private">Private</MenuRadioItem>
			<MenuRadioItem value="shared" icon="share">Shared</MenuRadioItem>
		</MenuRadioGroup>
		<MenuItem variant="danger">Delete</MenuItem>
	</MenuGroup>
</Menu>
