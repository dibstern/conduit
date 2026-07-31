<script lang="ts">
	import Menu from "../Menu.svelte";
	import MenuGroup from "../MenuGroup.svelte";
	import MenuItem from "../MenuItem.svelte";
	import MenuRadioGroup from "../MenuRadioGroup.svelte";
	import MenuRadioItem from "../MenuRadioItem.svelte";
	import MenuSeparator from "../MenuSeparator.svelte";

	let {
		open = $bindable(true),
		selected = $bindable("compact"),
	}: {
		open?: boolean;
		selected?: string;
	} = $props();
</script>

<output class="sr-only" data-testid="selected-value">{selected}</output>

<Menu bind:open ariaLabel="File actions" class="min-w-44">
	{#snippet trigger({ props })}
		<button
			{...props}
			class="rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:bg-bg-alt"
		>
			Open menu
		</button>
	{/snippet}

	<MenuGroup label="Actions">
		<MenuItem>Archive</MenuItem>
		<MenuItem>Duplicate</MenuItem>
		<MenuItem variant="danger">Delete</MenuItem>
	</MenuGroup>
	<MenuSeparator />
	<MenuGroup label="Density">
		<MenuRadioGroup bind:value={selected}>
			<MenuRadioItem value="compact">Compact</MenuRadioItem>
			<MenuRadioItem value="comfortable">Comfortable</MenuRadioItem>
		</MenuRadioGroup>
	</MenuGroup>
</Menu>
