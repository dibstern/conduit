<script lang="ts">
	import type { ComponentProps } from "svelte";
	// biome-ignore lint/style/useImportType: also rendered in the Svelte template.
	import HoldMenu from "./HoldMenu.svelte";
	// biome-ignore lint/style/useImportType: also rendered in the Svelte template.
	import Tile from "./Tile.svelte";

	let { title, hint, items, activation, ...tile }: Omit<ComponentProps<typeof Tile>, "triggerProps" | "held" | "onselect"> & Pick<ComponentProps<typeof HoldMenu>, "title" | "hint" | "items" | "activation"> = $props();
</script>

<HoldMenu {title} {hint} {items} {activation} icon={tile.icon}>
	{#snippet trigger({ props, held })}
		<Tile {...tile} {held} triggerProps={props} />
	{/snippet}
</HoldMenu>
