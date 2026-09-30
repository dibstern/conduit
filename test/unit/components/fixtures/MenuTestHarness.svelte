<script lang="ts">
	import Menu from "../../../../src/lib/frontend/components/ui/Menu.svelte";
	import MenuCheckboxItem from "../../../../src/lib/frontend/components/ui/MenuCheckboxItem.svelte";
	import MenuGroup from "../../../../src/lib/frontend/components/ui/MenuGroup.svelte";
	import MenuItem from "../../../../src/lib/frontend/components/ui/MenuItem.svelte";
	import MenuRadioGroup from "../../../../src/lib/frontend/components/ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../../../../src/lib/frontend/components/ui/MenuRadioItem.svelte";
	import MenuSeparator from "../../../../src/lib/frontend/components/ui/MenuSeparator.svelte";

	let {
		open = $bindable(true),
		selected = $bindable("compact"),
		onopenchange,
		onarchive,
		onproject,
		dangerIcon,
		portalTo,
		customAnchor,
		presentation,
	}: {
		open?: boolean;
		selected?: string;
		onopenchange?: (open: boolean) => void;
		onarchive?: () => void;
		onproject?: () => void;
		dangerIcon?: string | undefined;
		portalTo?: HTMLElement | string;
		customAnchor?: HTMLElement | null;
		presentation?: "popover" | "sheet";
	} = $props();
	let pinned = $state(false);
</script>

<output data-testid="menu-open">{String(open)}</output>
<output data-testid="menu-selected">{selected}</output>

<Menu
	bind:open
	{onopenchange}
	{portalTo}
	{customAnchor}
	{presentation}
	ariaLabel="Test actions"
	data-testid="menu"
>
	{#snippet trigger({ props })}
		<button {...props}>Open actions</button>
	{/snippet}

	<MenuGroup label="Actions" data-testid="actions-group">
		<MenuItem icon="archive" onselect={onarchive} data-testid="archive-item">
			Archive
		</MenuItem>
		<MenuItem variant="danger" icon={dangerIcon}>Delete</MenuItem>
		<MenuItem href="#project-a" onselect={onproject}>Open project</MenuItem>
		<MenuCheckboxItem bind:checked={pinned} data-testid="pinned-item">Pinned</MenuCheckboxItem>
		<MenuItem density="default" data-testid="explicit-density-item">Explicit density</MenuItem>
	</MenuGroup>
	<MenuSeparator />
	<MenuGroup label="Density">
		<MenuRadioGroup bind:value={selected}>
			<MenuRadioItem value="compact" icon="terminal" data-testid="compact-item">Compact</MenuRadioItem>
			<MenuRadioItem value="comfortable">Comfortable</MenuRadioItem>
		</MenuRadioGroup>
	</MenuGroup>
</Menu>
