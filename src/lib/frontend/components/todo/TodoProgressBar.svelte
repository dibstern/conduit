<!-- ─── Todo Progress Bar ─────────────────────────────────────────────────── -->
<!-- Horizontal bar showing completion percentage with animated width. -->

<script lang="ts">
	let { percentage }: { percentage: number } = $props();
</script>

<div class="todo-progress-bar-track h-[3px] bg-border-subtle overflow-hidden">
	<div
		class="todo-progress-bar-fill h-full bg-success transition-[width] duration-300 ease-out rounded-r-sm"
		style="width: {percentage}%"
	></div>
</div>
