<script lang="ts">
	import Badge from "../Badge.svelte";

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
