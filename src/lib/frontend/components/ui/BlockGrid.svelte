<script lang="ts">
	interface Props {
		/** Number of columns (blocks per row). Default 10. */
		cols?: number;
		/** Animation mode: 'static' (frozen gradient), 'animated' (cascade), 'fast' (spinner speed) */
		mode?: 'static' | 'animated' | 'fast';
		/** Block size in px. Default 3.5 */
		blockSize?: number;
		/** Gap between blocks in px. Default 1.5 */
		gap?: number;
		/** Enable glow effect on dark backgrounds. Default false */
		glow?: boolean;
		/** Additional CSS classes */
		class?: string;
	}

	let {
		cols = 10,
		mode = 'static',
		blockSize = 3.5,
		gap = 1.5,
		glow = false,
		class: className = '',
	}: Props = $props();

	// Calculate stagger delay per block based on column count
	// Total stagger spread stays ~1.6s for animated, ~1.0s for fast
	const staggerSpread = $derived(mode === 'fast' ? 1.0 : 1.6);
	const staggerStep = $derived(cols > 1 ? staggerSpread / (cols - 1) : 0);

	// Static opacity: linear gradient L→R for pink, R→L for cyan
	function staticOpacity(index: number, total: number): number {
		return 1 - (index / total) * 0.9; // 1.0 → 0.1
	}

	// Animation duration
	const duration = $derived(mode === 'fast' ? 1.4 : 2.4);
</script>

<div
	class="inline-grid {className}"
	style="grid-template-columns: repeat({cols}, {blockSize}px); grid-template-rows: repeat(2, {blockSize}px); gap: {gap}px;"
	role="img"
	aria-label="Conduit loading indicator"
>
	<!-- Top row: pink (brand-a), cascade L→R -->
	{#each Array(cols) as _, i}
		<div
			style="
				width: {blockSize}px;
				height: {blockSize}px;
				border-radius: {Math.max(0.5, blockSize / 4)}px;
				background: var(--color-brand-a);
				{mode === 'static'
				? `opacity: ${staticOpacity(i, cols)};`
				: `animation: pixel-cascade-a ${duration}s ease-in-out infinite; animation-delay: ${(i * staggerStep).toFixed(3)}s;`}
				{glow && mode !== 'static' ? `filter: drop-shadow(0 0 ${blockSize / 2}px var(--color-brand-a-glow));` : ''}
			"
		></div>
	{/each}

	<!-- Bottom row: cyan (brand-b), cascade R→L -->
	{#each Array(cols) as _, i}
		<div
			style="
				width: {blockSize}px;
				height: {blockSize}px;
				border-radius: {Math.max(0.5, blockSize / 4)}px;
				background: var(--color-brand-b);
				{mode === 'static'
				? `opacity: ${staticOpacity(cols - 1 - i, cols)};`
				: `animation: pixel-cascade-b ${duration}s ease-in-out infinite; animation-delay: ${((cols - 1 - i) * staggerStep).toFixed(3)}s;`}
				{glow && mode !== 'static' ? `filter: drop-shadow(0 0 ${blockSize / 2}px var(--color-brand-b-glow));` : ''}
			"
		></div>
	{/each}
</div>
