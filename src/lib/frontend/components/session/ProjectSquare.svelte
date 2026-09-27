<script lang="ts">
	let { label, accent = 1 }: { label: string; accent?: number } = $props();
	const colours = [
		"bg-project-1", "bg-project-2", "bg-project-3",
		"bg-project-4", "bg-project-5", "bg-project-6",
	] as const;
	const initials = $derived(label.match(/\p{L}/gu)?.slice(0, 2).join("").toUpperCase() ?? "");
	const colour = $derived(colours[accent - 1] ?? colours[0]);
</script>

<span class="project-square inline-grid size-[16px] shrink-0 place-items-center rounded-[4.5px] text-[8px] font-bold leading-none text-on-fill not-italic {colour}" aria-hidden="true">{initials}</span>
