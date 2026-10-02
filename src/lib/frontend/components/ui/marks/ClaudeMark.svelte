<!-- Claude's starburst mark, drawn in the Claude harness accent. -->
<script lang="ts">
	let { size = 16, class: className = "" }: { size?: number; class?: string } = $props();
	const rays = [
		[0, 1.5, 8.5], [40, 1.5, 8.5], [78, 2.5, 7.5], [118, 1.5, 8.5], [160, 2, 8],
		[200, 1.5, 8.5], [242, 2.5, 7.5], [282, 1.5, 8.5], [322, 2, 8],
	] as const;
</script>

<svg width={size} height={size} viewBox="0 0 24 24" class={className} aria-hidden="true">
	<g fill="var(--color-harness-claude)">
		{#each rays as [angle, y, height] (angle)}
			<rect x="11" {y} width="2" {height} rx="1" transform="rotate({angle} 12 12)" />
		{/each}
	</g>
</svg>
