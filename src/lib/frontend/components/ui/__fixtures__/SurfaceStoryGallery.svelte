<script lang="ts">
	import Surface from "../Surface.svelte";

	type GalleryAxis = "variants" | "padding-elevation";

	let { axis }: { axis: GalleryAxis } = $props();

	const variants = ["card", "inset", "floating", "plain"] as const;
	const paddings = ["none", "sm", "md", "lg"] as const;
	const elevations = ["none", "menu", "panel", "modal"] as const;
</script>

{#if axis === "variants"}
	<div class="grid grid-cols-2 gap-4">
		{#each variants as variant}
			<Surface {variant}>
				<span class="text-sm text-text">{variant}</span>
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
