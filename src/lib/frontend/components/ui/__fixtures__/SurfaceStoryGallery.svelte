<script lang="ts">
	import type { ComponentProps } from "svelte";
	import Surface from "../Surface.svelte";

	type GalleryAxis = "variants" | "padding-elevation" | "radius";

	let {
		axis = "variants",
	}: ComponentProps<typeof import("../Surface.svelte").default> & {
		axis?: GalleryAxis | undefined;
	} = $props();

	const variants = [
		"card",
		"quiet",
		"plain",
		"bare",
		"raised",
		"inset",
	] as const;
	const paddings = ["none", "sm", "md", "lg"] as const;
	const radii = ["none", "sm", "md", "lg", "panel"] as const;
	const elevations = [
		"none",
		"menu",
		"menu-lg",
		"panel",
		"modal",
		"dropdown",
	] as const;
</script>

{#if axis === "variants"}
	<div class="grid grid-cols-2 gap-4">
		{#each variants as variant}
			<Surface {variant} padding="md">
				<span class="text-sm text-text">{variant}</span>
			</Surface>
		{/each}
	</div>
{:else if axis === "radius"}
	<div class="grid grid-cols-2 gap-4">
		{#each radii as radius}
			<Surface {radius} padding="md">
				<span class="text-sm text-text">{radius}</span>
			</Surface>
		{/each}
	</div>
{:else}
	<div class="grid grid-cols-2 gap-4">
		{#each paddings as padding}
			{#each elevations as elevation}
				<Surface {padding} {elevation}>
					<span class="text-sm text-text">{padding} / {elevation}</span>
				</Surface>
			{/each}
		{/each}
	</div>
{/if}
