<script module lang="ts">
	type DitherState = "working" | "monitoring" | "done" | "idle";

	type Cell = { x: number; y: number; opacity: number; class?: string; style?: string };

	// Unlit pixels never drop below this, so every glyph keeps a solid
	// footprint on a white surface instead of fading to pastel.
	const FLOOR = 0.32;
	const lift = (level: number) => +(FLOOR + level * (1 - FLOOR)).toFixed(2);

	const grid = Array.from({ length: 16 }, (_, k) => ({ k, c: k % 4, r: Math.floor(k / 4) }));
	const at = (c: number, r: number) => ({ x: 1.7 + c * 3.4, y: 1.7 + r * 3.4 });

	// Uneven periods and staggered starts so the twinkle never visibly loops.
	const WORKING_LEVELS = [1, 0.25, 0.25, 1, 0.25, 1, 0.25, 0.25, 0.25, 0.25, 1, 0.25, 1, 0.25, 0.25, 1];
	const WORKING_PERIODS = [1.1, 1.7, 1.3, 0.9, 1.5, 1.2, 1.9, 1, 1.4, 0.8, 1.6, 1.25, 1.05, 1.8, 1.35, 0.95];

	const CELLS: Record<DitherState, Cell[]> = {
		working: grid.map(({ k, c, r }) => ({
			...at(c, r),
			opacity: lift(WORKING_LEVELS[k] ?? 0),
			class: "twinkle",
			style: `--period:${WORKING_PERIODS[k]}s;--delay:-${((k * 0.37) % 1.3).toFixed(2)}s`,
		})),
		// A band of light sweeping corner to corner: a steadier rhythm than the
		// twinkle, so watching and working stay distinguishable at a glance.
		// Reduced motion freezes on the middle diagonal (--still).
		monitoring: grid.map(({ c, r }) => ({
			...at(c, r),
			opacity: FLOOR,
			class: "sweep",
			style: `--delay:${((c + r) * 0.16 - 2.2).toFixed(2)}s;--still:${c + r === 3 ? 1 : FLOOR}`,
		})),
		done: grid.map(({ c, r }) => ({ ...at(c, r), opacity: 1 })),
		idle: grid.map(({ c, r }) => ({ ...at(c, r), opacity: lift((c + r) % 2 ? 0.12 : 0.4) })),
	};
</script>

<script lang="ts">
	let { state, size = 16 }: { state: DitherState; size?: number } = $props();
</script>

<!-- A 4x4 pixel grid on a faint tile of its own colour. Paints in
     currentColor, so the caller's text colour is the state colour. -->
<svg width={size} height={size} viewBox="0 0 16 16" class="block overflow-visible" aria-hidden="true">
	<rect width="16" height="16" rx="3.5" fill="currentColor" opacity="0.14" />
	{#each CELLS[state] as cell, k (k)}
		<rect
			x={cell.x}
			y={cell.y}
			width="2.8"
			height="2.8"
			rx="0.45"
			fill="currentColor"
			opacity={cell.opacity}
			class={cell.class}
			style={cell.style}
		/>
	{/each}
</svg>

<style>
	.twinkle {
		animation: twinkle var(--period) ease-in-out var(--delay) infinite;
	}

	@keyframes twinkle {
		50% {
			opacity: 1;
		}
	}

	.sweep {
		animation: sweep 2.2s ease-in-out var(--delay) infinite;
	}

	@keyframes sweep {
		0%,
		45%,
		100% {
			opacity: 0.32;
		}
		18% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.twinkle,
		.sweep {
			animation: none;
		}

		.sweep {
			opacity: var(--still);
		}
	}
</style>
