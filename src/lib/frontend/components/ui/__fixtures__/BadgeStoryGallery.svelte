<script lang="ts">
	import type { ComponentProps } from "svelte";
	import Badge from "../Badge.svelte";

	type BadgeStoryGalleryProps = ComponentProps<
		typeof import("../Badge.svelte").default
	>;

	let {
		children: _children,
		..._badgeProps
	}: BadgeStoryGalleryProps = $props();

	const variants = ["neutral", "accent", "success"] as const;
	const sizes = ["xs", "sm"] as const;
</script>

<div class="flex flex-wrap items-center gap-3">
	{#each variants as variant}
		{#each sizes as size}
			<Badge {variant} {size}>{variant} {size}</Badge>
		{/each}
	{/each}
</div>
