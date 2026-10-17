<script lang="ts">
	let { accent = 1 }: { accent?: number } = $props();
	const colours = ["bg-project-1", "bg-project-2", "bg-project-3", "bg-project-4", "bg-project-5", "bg-project-6"] as const;
</script>

<span class="project-mark size-[7px] shrink-0 rounded-[2px] {colours[accent - 1] ?? colours[0]}" aria-hidden="true"></span>
