<script lang="ts">
	import BlockGrid from './BlockGrid.svelte';

	interface Props {
		/** Size preset */
		size?: 'standard' | 'loading' | 'sidebar' | 'inline';
		/** Enable cascade animation. Default false (static). */
		animated?: boolean;
		/** Show "conduit" text above the grid. Default true. */
		showText?: boolean;
		/** Additional CSS classes */
		class?: string;
	}

	let {
		size = 'standard',
		animated = false,
		showText = true,
		class: className = '',
	}: Props = $props();

	const CONFIGS = {
		standard:  { textSize: 'text-2xl', blockSize: 3.5, gap: 1.5, cols: 10, gridGap: '4px', glow: true },
		loading:   { textSize: 'text-[28px]', blockSize: 8,   gap: 3,   cols: 10, gridGap: '6px', glow: true },
		sidebar:   { textSize: 'text-[14px]', blockSize: 2,   gap: 1,   cols: 10, gridGap: '3px', glow: false },
		inline:    { textSize: 'text-base', blockSize: 2,   gap: 0.75,cols: 5,  gridGap: '2px', glow: false },
	} as const;

	const config = $derived(CONFIGS[size]);

	const mode = $derived(
		animated
			? (size === 'inline' ? 'fast' : 'animated')
			: 'static'
	);
</script>

<div
	class="flex flex-col items-center {className}"
	style="gap: {config.gridGap};"
>
	{#if showText}
		<span
			class="font-medium tracking-[0.14em] text-text font-brand {config.textSize}"
		>
			conduit
		</span>
	{/if}
	<BlockGrid
		cols={config.cols}
		{mode}
		blockSize={config.blockSize}
		gap={config.gap}
		glow={config.glow}
	/>
</div>
