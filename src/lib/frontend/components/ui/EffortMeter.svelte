<script lang="ts">
	let {
		levels = 5,
		filled = 0,
	}: {
		levels?: number | undefined;
		filled?: number | undefined;
	} = $props();

	const count = $derived(Math.max(1, Math.min(8, Math.trunc(levels))));
	const active = $derived(Math.max(0, Math.min(count, Math.trunc(filled))));
</script>

<span data-testid="effort-meter" class="effort-meter inline-flex h-[13px] items-end gap-[2px]" aria-hidden="true">
	{#each Array.from({ length: count }, (_, index) => index) as index (index)}
		<span
			class="block w-[2.5px] shrink-0 rounded-[1px]"
			style:height={`${4 + (9 * index) / Math.max(1, count - 1)}px`}
			style:background-color={index < active ? "currentColor" : "var(--color-border-chip)"}
		></span>
	{/each}
</span>
