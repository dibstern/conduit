<script lang="ts">
	import type { ComponentProps } from "svelte";
	import HoldMenu from "./HoldMenu.svelte";
	import Tile from "./Tile.svelte";

	let { title, hint, items, ...tile }: Omit<ComponentProps<typeof Tile>, "triggerProps" | "held" | "onselect"> & Pick<ComponentProps<typeof HoldMenu>, "title" | "hint" | "items"> = $props();
</script>

<HoldMenu {title} {hint} {items} icon={tile.icon}>
	{#snippet trigger({ props, held })}
		<Tile {...tile} {held} triggerProps={props} />
	{/snippet}
</HoldMenu>
