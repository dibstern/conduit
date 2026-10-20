<script lang="ts">
	let { label, accent = 1, large = false, dot = false }: { label: string; accent?: number; large?: boolean; dot?: boolean } = $props();
	const colours = [
		"bg-project-1", "bg-project-2", "bg-project-3",
		"bg-project-4", "bg-project-5", "bg-project-6",
	] as const;
	const initials = $derived(label.match(/\p{L}/gu)?.slice(0, 2).join("").toUpperCase() ?? "");
	const colour = $derived(colours[accent - 1] ?? colours[0]);
</script>

<!-- `dot` is the bare colour mark draft rows use, so a draft never reads as a session row. -->
{#if dot}
<span class="project-square size-[7px] shrink-0 rounded-[2px] {colour}" aria-hidden="true"></span>
{:else}
<span class="project-square inline-grid {large ? 'size-[44px] rounded-[12px] text-[16px]' : 'size-[16px] rounded-[4.5px] text-[8px]'} shrink-0 place-items-center font-bold leading-none text-on-fill not-italic {colour}" aria-hidden="true">{initials}</span>
{/if}
